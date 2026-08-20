/**
 * 通知层组件（notification.md，追溯 R-08/R-09）。
 *
 * 注册在 `conversation.input.dock` 会话级 list 座位，渲染 null 布局；队列非空
 * 时渲染官方 Toast（text + 图标 + anchor + onDone 出队），Toast 自带 portal 到
 * body，不占布局、不干扰输入条。anchor 参照官方 InputBar 自身 Toast 的做法
 * 定位到 composer 卡片（`[data-composer-card]`）；缺失时按 viewport 居中降级。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { IconCheckOutline16, IconWarningOutline16, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { dismiss, getNotifySnapshot, subscribeNotify } from './notify-store.js'

/**
 * Dock 条目组件：订阅通知队列，逐条展示 Toast，出队后展示下一条。
 * 队列空时渲染 null（座位占位，无可见副作用）。
 */
export function NotificationDock(): React.JSX.Element | null {
  const items = useSyncExternalStore(subscribeNotify, getNotifySnapshot, getNotifySnapshot)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  useEffect(() => {
    // 官方 composer 卡片定位（与 InputBar 自身 Toast 的 cardRef 同一选择器）。
    setAnchor(document.querySelector('[data-composer-card]'))
  }, [])

  const head = items.length > 0 ? items[0] : undefined
  if (head === undefined) return null

  const icon = head.kind === 'warning' ? <IconWarningOutline16 /> : <IconCheckOutline16 />
  return (
    <Toast
      key={head.seq}
      text={head.text}
      icon={icon}
      anchor={anchor}
      onDone={() => { dismiss(head.seq) }}
    />
  )
}
