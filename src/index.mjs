import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { builtinAgents } from './agents.mjs'
import { Coordinator } from './coordinator.mjs'
import { RunCatalog, mountApproval, mountDashboard, mountModels } from './dashboard.mjs'
import { importTickets, writeback } from './tracker.mjs'

export const name = 'dsh-ticket-dag'
export const inject = [
  'tools',
  'systemPrompt',
  'subagents',
  'agents',
  'workingDirectory',
  'sessions',
  'sessionQuery',
  'sessionPersistence',
]
export const Config = z.object({
  checks: z
    .dict(z.array(z.array(z.string()).min(1)).min(1))
    .default({})
    .volatile(),
  agents: z
    .dict(
      z.object({
        name: z.string().default(''),
        description: z.string().default(''),
        instructions: z.string().default(''),
        provider: z.string().default(''),
        model: z.string().default(''),
        reasoningEffort: z.string().default(''),
        maxConcurrent: z.natural().max(32).default(0),
      }),
    )
    .default(builtinAgents)
    .volatile(),
  requireApproval: z.boolean().default(true).volatile(),
  autoCleanup: z.boolean().default(true).volatile(),
  maxAppendedTickets: z.natural().default(20).volatile(),
  maxWorkers: z.natural().min(1).max(32).default(16).volatile(),
  checkTimeoutMs: z.natural().min(1).max(2_147_483_647).default(120000).volatile(),
  // What an integrated ticket imported from GitHub reports on its issue.
  trackerWriteback: z.union(['off', 'comment', 'close']).default('off').volatile(),
  // Ask the captain for one code-review round when a run first completes.
  reviewOnComplete: z.boolean().default(false).volatile(),
})

const runId = { type: 'string', required: true, description: 'The runId returned by dag_run.' }
const runTools = [
  ['status', 'Inspect persisted tickets, attempts, integration state, and diagnostics.'],
  ['pause', 'Pause admission of new tickets in the selected run.'],
  ['resume', 'Reconcile the run and resume scheduling eligible tickets.'],
  ['retry', 'Retry a specific ticket after resolving its reported blocker.'],
  ['cancel', 'Cancel the run and stop its owned workers.'],
  [
    'cleanup',
    'Remove the recorded worktrees and branches of the integrated tickets in a run, including an ended one, and return each ticket result. Unmerged worktrees and worktrees with tracked changes, untracked or ignored files are kept and skipped with a reason; repeating it is harmless.',
  ],
]
const sourceKind = 'dsh-ticket-dag'
const commandSource = 'dsh-ticket-dag-command'
// /dag alone or followed by whitespace; /dagger and mid-sentence mentions do not count.
const commandPattern = /^\/dag(?=$|\s)/u
// Agent Teams, agent team, AgentTeams, agent-teams in any case, also right next to Chinese text;
// "agentteamsx" or "subagent team" do not count.
const keywordPattern = /(?<![a-z0-9])agent[\s_-]*teams?(?![a-z0-9])/i

// How the captain verifies tickets: verify is optional, profile checks are
// listed by ID, and the manifest may carry its own commands for the user to approve.
function checkList(checks) {
  const ids = Object.keys(checks ?? {})
  return [
    'Verification is optional per ticket. An empty or omitted verify list means the ticket has no check of its own: its candidate still runs the accumulated regression checks of the tickets already integrated in this run, then integrates once those pass and its trial merge is clean and the candidate is reviewed. Use that for docs or other work no command can check.',
    ids.length
      ? 'Profile check IDs (trusted, no approval needed): ' +
        ids.map((id) => id + ' = ' + checks[id].map((argv) => argv.join(' ')).join(' && ')).join('; ') +
        '.'
      : 'This profile has no checks configured.',
    'When code needs a check none of those cover, add your own to the manifest: "checks": {"<id>": [["program", "arg", ...], ...]}, each argv run in order without a shell in the candidate checkout, then name the id in verify. Derive the command from this repository (its test runner, lockfile, CI), never assume one; prefer a fast, targeted command; IDs must differ from profile IDs. The user sees and approves these commands with the plan (a manifest with its own checks always waits for approval). Never invent a check that only pretends to verify.',
  ].join(' ')
}

const writebackMode = (value) => (['comment', 'close'].includes(value) ? value : 'off')

// A spec or tickets on a tracker (from /to-spec and /to-tickets) are imported, not re-split.
const importRule =
  'When the goal points at a spec or its tickets (a GitHub issue number or URL, or a local .scratch/<slug> folder, spec.md or issues folder from /to-spec and /to-tickets), call dag_import with it first and build the manifest from its draft. If dependencyMode is declared, keep every ticket and its depends_on exactly as imported: add only verify, agent and manifest checks, and report a dependency that looks wrong instead of changing it. If dependencyMode is none, keep the imported tickets and infer depends_on yourself. If it is no-tickets, split the spec into tickets yourself. Whenever you infer an edge, write its reason into the dependent ticket prompt so the user sees it in the plan review. Keep each ticket source field so the run can report back to the issue.'

export function captainSection({ checks, agents, trackerWriteback, reviewOnComplete, checkTimeoutMs, maxWorkers }) {
  const presets = Object.keys(agents ?? {})
  const limits =
    'Give each ticket the preset that matches its kind of work (for example UI tickets to a frontend preset, real-host acceptance to a verifier preset) instead of one preset for every ticket. Set max_workers explicitly' +
    (maxWorkers ? ' (this profile allows at most ' + maxWorkers + ')' : '') +
    ' and tell the user the value; tickets that edit the same files conflict more when many run at once. Each check command has ' +
    Math.round((checkTimeoutMs ?? 120000) / 1000) +
    ' seconds before it times out; pick checks that finish within that.' +
    ' A trial-merge conflict is sent back to the ticket worker automatically; you are notified only if it keeps conflicting. Then merge the integration branch into that ticket branch in its worktree, commit it with the ticket current DAG trailers, and call dag_retry, which submits that commit without starting a new worker; a ticket added with dag_add cannot change another ticket branch.'
  return [
    'dsh-ticket-dag is this profile’s Agent Teams plugin: it runs a coding goal as a DAG of tickets, one worker per ticket in its own git worktree, verified and merged into an integration branch.',
    'A user message that starts with /dag or contains "Agent Teams" (any case, also agent team or AgentTeams) always activates it, and the host then adds a directive for that step. Otherwise use it only when the user explicitly asks for it (teams, 工单团队, ticket DAG) and the work splits into two or more tickets; mentioning, discussing or declining it is not a request, and a single small change is done directly, without dag_run.',
    'As captain: read the code first, split the goal into tickets with id, title, a self-contained prompt, depends_on for genuine prerequisites, acceptance, verify and agent' +
      (presets.length ? ' (presets: ' + presets.join(', ') + ')' : '') +
      ', then call dag_run in the current repository. ' +
      checkList(checks),
    limits,
    importRule +
      (writebackMode(trackerWriteback) === 'off'
        ? ' This profile does not report back to GitHub issues; do not close or comment on them yourself unless the user asks.'
        : ' This profile reports each integrated GitHub ticket on its issue (' + writebackMode(trackerWriteback) + '); do not do it yourself.'),
    reviewOnComplete === true
      ? 'This profile reviews each run once: the first completion notice asks you to run code-review on the integration branch and add fixes with dag_add. Follow it; do not review again after the fixes land.'
      : '',
    'Only the top-level captain may use dag_* tools. Keep the runId. When dag_run returns mode staged, tell the user to review and approve the plan in the 「工单 · <runId>」 tab of the right sidebar, then end the turn; after starting, end the turn when only waiting remains. The host schedules work and notifies you. Use dag_status for inspection, dag_resume after a host restart, and dag_retry only after addressing the specified ticket blocker. dag_cleanup removes the worktrees and branches of integrated tickets in a run. dag_add appends tickets to a run: they need no user approval, may use profile checks or the checks already in the run manifest, and cannot add new commands. Workers complete their own assignment and leave orchestration to the captain.',
  ]
    .filter(Boolean)
    .join('\n')
}

// The latest user message activates the plugin when it starts with /dag or names Agent Teams anywhere.
function invocation(messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m?.source?.kind === 'user')
  const text = last?.content?.find((block) => block.type === 'text')?.text?.trim() ?? ''
  if (commandPattern.test(text)) return { trigger: 'the /dag command', goal: text.slice(4).trim() }
  if (keywordPattern.test(text)) return { trigger: 'the Agent Teams keyword', goal: text }
  return undefined
}

function commandDirective({ trigger, goal }, checks) {
  return [
    'The user activated dsh-ticket-dag, this profile’s Agent Teams plugin, with ' + trigger + '. Follow the dsh-ticket-dag captain rules in your system instructions.',
    'Inspect the repository, split the goal into two or more tickets with genuine dependencies only, and call dag_run in this repository. If the goal names a spec or tickets on a tracker, call dag_import first and follow its dependencyMode. If it returns staged, ask the user to review the plan in the right sidebar and end the turn; do not approve it yourself.',
    checkList(checks),
    goal ? 'Goal: ' + goal : 'No goal was given: ask the user what the team should accomplish.',
  ].join('\n')
}
const detailLimit = 4096
const childLabel = 'dsh-ticket-dag/'

function topLevel(agent) {
  const header = agent?.session?.header
  return header && header.origin !== 'subagent' && !header.delegationDepth
}

function alreadyEnqueued(log, eventId) {
  return log.events
    .slice(log.inheritedEventCount)
    .some(
      (event) =>
        event.type === 'agent/inbox/spliced' &&
        event.data.inserted.some(
          (message) => message.source?.kind === sourceKind && message.source.eventId === eventId,
        ),
    )
}

function concluded(log, parentId) {
  if (log.session.origin !== 'subagent' || log.session.parentSession !== parentId) return false
  for (let i = log.events.length - 1; i >= log.inheritedEventCount; i--) {
    const event = log.events[i]
    if (
      event.type === 'turn/start' ||
      (event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)
    )
      return false
    if (event.type === 'turn/end') {
      return ['completed', 'error', 'aborted', 'max-tokens', 'refusal'].includes(event.data.reason?.kind)
    }
  }
  return false
}

// Loader supplies volatile fields as references. A programmatic mount may
// instead supply the plain values accepted by earlier plugin versions.
function setting(field, fallback) {
  return typeof field?.get === 'function' ? field.get() : (field ?? fallback)
}

export function apply(ctx, config = {}, { importer = importTickets, reporter = writeback } = {}) {
  const settings = () => ({
    checks: setting(config.checks, {}),
    agents: setting(config.agents, builtinAgents),
    requireApproval: setting(config.requireApproval, true),
    autoCleanup: setting(config.autoCleanup, true),
    maxAppendedTickets: setting(config.maxAppendedTickets, 20),
    maxWorkers: setting(config.maxWorkers, 16),
    checkTimeoutMs: setting(config.checkTimeoutMs, 120000),
    trackerWriteback: writebackMode(setting(config.trackerWriteback, 'off')),
    reviewOnComplete: setting(config.reviewOnComplete, false) === true,
  })
  const live = new Map()
  const notifying = new Map()
  let closing = false

  async function captain(parentId) {
    if (closing) throw new Error('DAG plugin is stopping')
    const seen = ctx.agents.get(parentId)
    const resolved = seen ? { agent: seen } : await ctx.get('sessionController')?.resolveAgent(parentId)
    if (resolved?.error)
      throw new Error('The original captain session could not be restored', { cause: resolved.error })
    const agent = resolved?.agent
    if (!topLevel(agent) || agent.id !== parentId || ctx.agents.get(parentId) !== agent) {
      throw new Error('Open the original captain session and resume this run')
    }
    return agent
  }

  async function launch({ parentId, childId, cwd, prompt, agentOptions, signal, runId, ticketId, attempt }) {
    if (!isAbsolute(cwd)) throw new Error('Worker worktree path must be absolute')
    const parent = await captain(parentId)
    signal.throwIfAborted()
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: childLabel + runId + '/' + ticketId + '#' + attempt,
      childId,
      request: { parent, cwd, prompt: [{ type: 'text', text: prompt }], ...(agentOptions && { agentOptions }) },
      signal,
      delivery: 'caller',
    })
    if (activation.childId !== childId) {
      await activation.dispose()
      throw new Error('Harness returned an unexpected child ID')
    }
    let disposal
    const dispose = () => (disposal ??= Promise.resolve().then(() => activation.dispose()))
    live.set(childId, dispose)
    const result = activation.result
      .then((value) => {
        const ok = value.stopReason === 'completed'
        const detail = ok
          ? (value.output ?? [])
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n')
          : value.stopReason + (value.diagnostic ? ' — ' + value.diagnostic : '')
        return { ok, detail: detail.slice(0, detailLimit) }
      })
      .finally(() => live.delete(childId))
    return { childId, result, dispose }
  }

  async function deliver({ parentId, eventId, text }) {
    const agent = await captain(parentId)
    const log = await ctx.sessionQuery.readSession(parentId)
    if (!alreadyEnqueued(log, eventId)) {
      agent.followup(
        createUserMessage({
          source: { kind: sourceKind, eventId },
          content: [{ type: 'text', text: String(text).slice(0, 8192) }],
        }),
      )
    }
    return (await ctx.sessions.flush(agent.session)) === true
  }

  function notify(event) {
    const key = JSON.stringify([event.parentId, event.eventId])
    if (notifying.has(key)) return notifying.get(key)
    const pending = deliver(event)
      .catch((error) => {
        ctx.logger.warn('DAG notice remains pending: ' + String(error).slice(0, 300))
        return false
      })
      .finally(() => notifying.delete(key))
    notifying.set(key, pending)
    return pending
  }

  async function canRetry({ parentId, childId }) {
    if (!childId || live.has(childId) || ctx.agents.get(childId)) return false
    try {
      const history = await ctx.sessionQuery.readSession(childId)
      return !ctx.agents.get(childId) && concluded(history, parentId)
    } catch {
      return false
    }
  }

  const catalog = new RunCatalog(ctx.get('profileContext')?.dir)
  function rememberRun(file, meta, startedAt) {
    try {
      catalog.remember(file, meta, startedAt)
    } catch (error) {
      ctx.logger.warn('Cannot index this run for the dashboard: ' + String(error).slice(0, 300))
    }
  }
  const coordinator = new Coordinator({ launch, notify, canRetry, rememberRun, writeback: reporter, ...settings() })
  ctx.inject?.(['connection'], (scope) => {
    // A ticket without its own model inherits the captain's route, so the board shows it.
    mountDashboard(scope, catalog, coordinator, (parentId) => ctx.agents.get(parentId)?.options)
    mountApproval(scope, catalog, coordinator, () => ctx.get('llm'))
    mountModels(scope, () => ctx.get('llm'))
  })
  ctx.on('loader/volatile-update', () => coordinator.updateSettings(settings()))
  ctx.inject?.(['settings'], (scope) => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
  })
  // The session header carries the original project's cwd on RC2. Spawn
  // commits the child's assigned directory immediately after its descriptor.
  // Read that immutable record once per live instance; later cd cannot change
  // which repository's attempt ledger authorizes the worker.
  const identities = new WeakMap()
  const denied = new WeakSet()
  async function childIdentity(agent) {
    if (identities.has(agent)) return identities.get(agent)
    const log = await ctx.sessionQuery.readSession(agent.id)
    const own = log.events.slice(log.inheritedEventCount)
    const at = own.findIndex((event) => event.type === 'subagent/descriptor')
    const label = at >= 0 ? own[at].data.label : ''
    const cwd =
      own.slice(at + 1).find((event) => event.type === 'working-directory/change')?.data.cwd ??
      agent.session.header.cwd
    const info = {
      cwd,
      childId: agent.id,
      parentId: agent.session.header.parentSession,
      tagged: typeof label === 'string' && label.startsWith(childLabel),
    }
    identities.set(agent, info)
    return info
  }
  const reason = 'This DAG worker no longer owns the ticket. Resume or retry it from its captain session.'
  async function mayRun(agent) {
    if (!agent || topLevel(agent)) return true
    if (denied.has(agent)) return false
    try {
      const identity = await childIdentity(agent)
      // Ordinary DSH subagents belong to their own providers and controls.
      if (!identity.tagged) return true
      const decision = await coordinator.childAuthorization(identity)
      if (decision === 'authorized') return true
      denied.add(agent)
    } catch (error) {
      ctx.logger.warn('DAG worker authorization could not be verified: ' + String(error).slice(0, 300))
    }
    return false
  }
  // The captain directive rides on the same pre-step hook that fences retired workers.
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (!(await mayRun(agent))) return { kind: 'reject' }
    const decision = await next()
    if (decision?.kind !== 'enter' || !topLevel(agent)) return decision
    const invoked = invocation(messages)
    if (invoked === undefined) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: commandDirective(invoked, settings().checks) }],
          source: { kind: commandSource },
        }),
      ],
    }
  })
  ctx.on('tools/pre-execute', async (exec, next) =>
    (await mayRun(exec.agent)) ? next() : { kind: 'deny', reason },
  )
  ctx.tools.guard((exec) => (exec.agent && denied.has(exec.agent) ? reason : undefined))

  const attaching = new Set()
  function attachWhenPublished({ agent }) {
    if (!topLevel(agent)) return
    // agent/created can run before AgentRegistry publication. Defer I/O past it.
    const job = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        if (closing || ctx.agents.get(agent.id) !== agent) return
        const cwd = await ctx.workingDirectory.ensure(agent)
        if (closing) return
        const scan = await coordinator.attach({ cwd, parentId: agent.id })
        for (const { runId, error } of scan.failures ?? [])
          ctx.logger.warn('DAG recovery scan, run ' + runId + ': ' + error.slice(0, 500))
      })
      .catch((error) => ctx.logger.warn('DAG recovery scan: ' + String(error).slice(0, 300)))
      .finally(() => attaching.delete(job))
    attaching.add(job)
  }
  ctx.on('agent/created', attachWhenPublished)
  for (const agent of ctx.agents.list()) attachWhenPublished({ agent })
  const output = {
    schema: { type: 'json' },
    render: (_args, snapshot) => [{ type: 'text', text: JSON.stringify(snapshot) }],
  }

  function register(method, description, parameters) {
    ctx.tools.register(
      defineTool({
        name: 'dag_' + method,
        description,
        parameters,
        output,
        async execute(args, exec) {
          const agent = exec.agent
          if (!topLevel(agent) || ctx.agents.get(agent.id) !== agent) {
            throw new Error('Only the live top-level captain can control a DAG run')
          }
          if (closing) throw new Error('DAG plugin is stopping')
          const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
          const request = { cwd, parentId: agent.id, runId: args.runId }
          if (method === 'run') {
            const manifest = typeof args.manifest === 'string' ? JSON.parse(args.manifest) : args.manifest
            return JSON.parse(JSON.stringify(await coordinator.start({ ...request, manifest })))
          }
          if (method === 'add')
            request.tickets = typeof args.tickets === 'string' ? JSON.parse(args.tickets) : args.tickets
          if (method === 'retry') {
            request.id = args.id
            if (args.isolated !== undefined) request.isolated = args.isolated
          }
          return JSON.parse(JSON.stringify(await coordinator[method](request)))
        },
      }),
    )
  }

  register(
    'run',
    'Start the approved spec manifest and return its runId. Reusing a runId with the same manifest is idempotent. Each ticket verify list is optional and names check IDs: a profile check, or one defined in the manifest checks object ({"<id>": [["program", "arg"]]}), which the user approves with the plan; a ticket without checks integrates after a clean merge. A ticket may set agent to a configured agent preset ID (for example implementer, frontend, verifier, test-writer, docs or merger) to give its worker that role and model; omit it for the default worker. When the result mode is staged, nothing has started: the user reviews each ticket preset and model in the 「工单 · <runId>」 tab of the conversation right sidebar and approves or discards the plan there. Tell the user that and end the turn; you are notified once it is approved. dag_resume cannot start a staged run. To add work to this run later, use dag_add instead of a new dag_run.',
    {
      manifest: { type: 'json', required: true, description: 'Ticket DAG manifest object or JSON string.' },
      runId: {
        type: 'string',
        description: 'Optional stable run ID. Omit to use the spec and captain identity.',
      },
    },
  )
  for (const [method, description] of runTools) {
    register(
      method,
      description,
      method === 'retry'
        ? {
            runId,
            id: { type: 'string', required: true, description: 'Ticket ID.' },
            isolated: {
              type: 'boolean',
              description:
                'Start a replacement in a new worktree from the frozen base and retain the old worktree for inspection.',
            },
          }
        : { runId },
    )
  }
  register(
    'add',
    'Append tickets to an existing run; existing tickets cannot be changed or removed. Each ticket follows the dag_run manifest ticket rules (id, title, prompt, depends_on, optional verify, optional agent); depends_on may name tickets already in the run or in this batch. verify may name profile checks or checks the run manifest defined; a batch cannot define new commands. Appended tickets need no user approval and are dispatched at once; a run still waiting for approval takes them into the plan under review. An agent preset already approved in this run keeps the model the user chose. Repeating an identical batch is harmless. A cancelled run refuses, and a run takes at most the configured number of appended tickets; beyond that start a new run.',
    {
      runId,
      tickets: {
        type: 'json',
        required: true,
        description: 'Array of ticket objects in the dag_run manifest format, or a JSON string of it.',
      },
    },
  )
  ctx.tools.register(
    defineTool({
      name: 'dag_import',
      description:
        'Read a spec and its tickets from the tracker that /to-spec and /to-tickets publish to, and return a dag_run manifest draft without starting anything. spec is a GitHub issue number (#12 or 12) or URL whose sub-issues are the tickets, or a local .scratch/<slug> folder (spec.md plus issues/NN-*.md). Each ticket carries id, title, prompt (the ticket body with a pointer to the spec), acceptance (its checkboxes), depends_on and source. dependencyMode tells you what to do: declared means the tracker gave blocking edges (GitHub native dependencies or Blocked by lines), so keep depends_on unchanged; none means infer depends_on yourself; no-tickets means split the spec yourself. Closed issues and done local tickets are skipped and listed; a blocker that is closed counts as satisfied; an open blocker outside the spec is an error. Add verify, agent and checks, then call dag_run.',
      parameters: {
        spec: {
          type: 'string',
          required: true,
          description: 'GitHub issue number or URL of the spec, or a local spec path.',
        },
        repo: {
          type: 'string',
          description: 'owner/name for a bare issue number; defaults to the current repository.',
        },
      },
      output,
      async execute(args, exec) {
        const agent = exec.agent
        if (!topLevel(agent) || ctx.agents.get(agent.id) !== agent) {
          throw new Error('Only the live top-level captain can import tickets')
        }
        if (closing) throw new Error('DAG plugin is stopping')
        const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
        return JSON.parse(JSON.stringify(await importer({ cwd, spec: args.spec, repo: args.repo })))
      },
    }),
  )
  ctx.systemPrompt.section({
    name: 'tool:dsh-ticket-dag',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    // Read on every build, so newly saved checks and presets reach the captain.
    text: () => captainSection(settings()),
  })
  // /dag <goal> is the deterministic entry; the pre-step hook above adds the directive.
  ctx.inject?.(['commands'], (scope) => {
    scope.effect(
      () =>
        scope.commands.register({
          name: 'dag',
          description: 'run a goal as an Agent Teams ticket DAG (you become the captain)',
          input: { hint: '<goal>' },
          handler(invocation) {
            const goal = invocation.rawInput.trim()
            if (!goal) return { kind: 'error', text: 'Usage: /dag <goal>' }
            invocation.agent.followup(
              createUserMessage({ content: [{ type: 'text', text: '/dag ' + goal }], source: { kind: 'user' } }),
            )
            return { kind: 'success', text: 'Agent Teams activated: the captain will split the goal into tickets.' }
          },
        }),
      'dsh-ticket-dag: /dag command',
    )
  })
  ctx.effect(
    () => async () => {
      closing = true
      await Promise.allSettled([...attaching])
      try {
        await coordinator.close()
      } finally {
        await Promise.allSettled([...live.values()].map((dispose) => dispose()))
        await Promise.allSettled([...notifying.values()])
      }
    },
    'dsh-ticket-dag: shutdown',
  )
}
