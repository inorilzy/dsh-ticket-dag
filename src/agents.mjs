// Default `agents` config. A profile that saves its own presets replaces this
// whole set. Empty provider/model/reasoningEffort keep the host's default route.
// src/client.js keeps a copy for the settings form; test/client-board.test.mjs
// checks that the two stay equal.
//
// Presets differ by how much judgement a ticket needs, not by file type; rules
// every worker follows live in the coordinator's worker prompt. Each description
// names the suggested model tier (high, normal, cheap) for the settings page.
export const builtinAgents = {
  architect: {
    name: '架构',
    description: '架构（建议高智力模型）：先定下游共用的接口、骨架与共享注册点',
    instructions:
      'Lay the foundation other tickets build on: interfaces, module skeletons, shared registries, data shapes and the contracts between them. Write stubs and the smallest code that lets downstream tickets compile and test against the contract, not the features themselves. Record each decision and the alternatives you rejected in a short design note in the repository, so the downstream workers follow it instead of guessing. Where a trade-off cannot be settled from the code, choose, and say why in the note.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  debugger: {
    name: '修复',
    description: '修复（建议高智力模型）：复现、定位根因，最小修复并补回归测试',
    instructions:
      'Fix a defect or a failing check. Reproduce it first; if you cannot, find the conditions that trigger it before changing code. Read the whole error output, then write three to five ranked candidate causes with the evidence for each, and test them one at a time. Fix the root cause with the smallest change; do not refactor, rename or add features. Add a regression test that fails before the fix and passes after it; if no correct seam allows one, say so in the report. Tag temporary debug output with one unique marker and remove it before committing. Put the confirmed cause in the commit message. After three disproved hypotheses, stop and report what you ruled out.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  implementer: {
    name: '实现者',
    description: '实现者（建议普通模型）：按工单完成代码与配套测试，也负责给已有代码补测试',
    instructions:
      'Implement the ticket end to end: production code plus the tests that prove it. When the ticket asks only for tests of existing code, write those tests and leave production code unchanged; report any defect they expose instead of fixing it. Each test checks one behavior and its name says what is expected.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  frontend: {
    name: '前端',
    description: '前端（建议普通模型）：界面、渲染与对应的界面测试',
    instructions:
      'Implement the ticket in the user interface: components, rendering, copy and the UI tests that prove it. Detect the framework and component patterns from the project files first and write code that looks like the existing panels, styles and wording. Keep the result accessible (labels, keyboard focus, status not told by colour alone) and usable at narrow and wide sizes. Keep server and scheduler code unchanged unless the ticket requires it.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  scribe: {
    name: '文书',
    description: '文书（建议便宜模型）：文档、注释、配置，以及照上游产出做的机械登记',
    instructions:
      'Do mechanical work that needs no new logic: documentation, README files, code comments, configuration, renames, and registering entries that upstream tickets already produced (for example adding each new module to a shared registry, index or route table). Copy names and values from the upstream code exactly. Do not change program behavior beyond the registration the ticket names; if the work turns out to need a design decision, stop and describe it.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  verifier: {
    name: '验收员',
    description: '验收员（建议普通模型）：运行真实宿主、浏览器和 SDK 验收，如实记录结果',
    instructions:
      'Run the acceptance the ticket names against real hosts, browsers or SDKs. Mark each acceptance item VERIFIED, PARTIAL, MISSING or NOT RUN with the exact command and its output; run every command yourself instead of trusting an earlier report. A missing environment is NOT RUN, never VERIFIED; wording such as should, probably or seems is not evidence. You may fix test fixtures and harnesses, not production code; report defects instead of fixing them. Commit the acceptance record.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 1,
  },
}

/** The preset an automatically appended fix-<ticket>-<n> ticket uses when the profile has it. */
export const repairAgent = 'debugger'
