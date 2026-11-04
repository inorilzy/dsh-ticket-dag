// Default `agents` config. A profile that saves its own presets replaces this
// whole set. Empty provider/model/reasoningEffort keep the host's default route.
// src/client.js keeps a copy for the settings form; test/client-board.test.mjs
// checks that the two stay equal.
export const builtinAgents = {
  implementer: {
    name: '实现者',
    description: '实现者：按工单完成代码与配套测试',
    instructions:
      'Implement the ticket end to end: production code plus the tests that prove it. Keep the change limited to what the ticket asks for.',
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
}
