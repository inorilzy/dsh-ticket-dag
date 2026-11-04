// This models only the provider's Messages SSE protocol. DSH executes the tools,
// actually creates the child and its Git commit, then wakes the original captain.
export function reply(res, tool, input) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const write = (type, fields) =>
    res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n')
  write('message_start', {
    message: {
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-pro',
      content: [],
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  })
  write('content_block_start', {
    index: 0,
    content_block: tool
      ? { type: 'tool_use', name: tool, id: 'call-' + tool, input: {} }
      : { type: 'text', text: '' },
  })
  write('content_block_delta', {
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(input) }
      : { type: 'text_delta', text: 'Fixture turn complete.' },
  })
  write('content_block_stop', { index: 0 })
  write('message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: 15 },
  })
  write('message_stop', {})
  res.end()
}
