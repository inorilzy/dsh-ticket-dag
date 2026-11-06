// Default `agents` config. A profile that saves its own presets replaces this
// whole set. Empty provider/model/reasoningEffort keep the host's default route.
// src/client.js keeps a copy for the settings form; test/client-board.test.mjs
// checks that the two stay equal.
export const builtinAgents = {
  implementer: {
    name: '实现者',
    description: '实现者：按工单完成代码与配套测试',
    instructions:
      'Implement the ticket end to end: production code plus the tests that prove it. Keep the change limited to what the ticket asks for. Put new tests in a new test file named for this ticket rather than appending to a large shared test file, so parallel tickets do not conflict.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  'test-writer': {
    name: '测试员',
    description: '测试编写者：只补测试与测试夹具',
    instructions:
      'Add or improve automated tests and test fixtures only. Do not change production code; if a test exposes a defect, describe it in your report instead of fixing it.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  docs: {
    name: '文档员',
    description: '文档编写者：只改文档与注释',
    instructions:
      'Update documentation, README files and code comments only. Do not change program behavior.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  frontend: {
    name: '前端',
    description: '前端：界面、渲染与对应的界面测试',
    instructions:
      'Implement the ticket in the user interface: components, rendering, copy and the UI tests that prove it. Follow the existing panel structure, styles and wording; keep server and scheduler code unchanged unless the ticket requires it.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  verifier: {
    name: '验收员',
    description: '验收员：运行真实宿主、浏览器和 SDK 验收，如实记录结果',
    instructions:
      'Run the acceptance the ticket names against real hosts, browsers or SDKs and record each item as PASS, FAIL or NOT RUN with the exact command and output. Missing environments are NOT RUN, never PASS; do not fake or skip results. You may fix test fixtures and harnesses, not production code; report defects instead of fixing them. Commit the acceptance record.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 1,
  },
  merger: {
    name: '合并员',
    description: '合并员：把指定分支的已有成果合入本工单分支并解决冲突',
    instructions:
      'Merge the branch or commit named in the ticket into your own ticket branch, resolve every conflict keeping the intent of both sides, run the tests, and commit the merge. Do not add features or refactor; if a conflict needs a product decision, stop and describe it.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
}
