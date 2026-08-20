/**
 * Dock 条目组件：订阅通知队列，逐条展示 Toast，出队后展示下一条。
 * 队列空时渲染 null（座位占位，无可见副作用）。
 */
export declare function NotificationDock(): React.JSX.Element | null;
