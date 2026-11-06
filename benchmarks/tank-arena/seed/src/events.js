// 事件总线与事件注册点（工单 02 实现）。各工单在 EVENT_TYPES 注册自己发出的事件及字段。
// soak 会把 inspect().emittedEvents 中未注册的事件类型报为错误。
export const EVENT_TYPES = {}
