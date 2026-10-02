<script setup lang="ts">
import AppIcon from '../AppIcon.vue'
import { useToasts, dismissToast, pauseToast, resumeToast } from '../../composables/toast'
import type { ToastType } from '../../composables/toast'

/**
 * 顶部通知区：全局唯一的 toast 渲染出口（挂在 App 根组件）。
 * - 进场自顶部下滑弹入，离场淡出上收，堆叠增减时其余通知平滑补位
 * - 悬停时暂停自动关闭（CSS 动画与 JS 计时同步暂停），移出后按剩余时长恢复
 */
const toasts = useToasts()

/** 各类型对应的图标与配色 */
const APPEARANCE: Record<ToastType, { icon: string; iconClass: string; bg?: string }> = {
  success: { icon: 'check-circle', iconClass: 'text-success', bg: 'var(--green-bg)' },
  error: { icon: 'warn', iconClass: 'text-danger' },
  warning: { icon: 'warn', iconClass: 'text-warning-icon' },
  info: { icon: 'info', iconClass: 'text-primary' },
}
</script>

<template>
  <div class="toast-region" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="t.type"
        role="status"
        @mouseenter="pauseToast(t.id)"
        @mouseleave="resumeToast(t.id)"
      >
        <AppIcon
          :name="APPEARANCE[t.type].icon"
          :size="15"
          :bg="APPEARANCE[t.type].bg"
          :class="APPEARANCE[t.type].iconClass"
        />
        <div class="toast-body">
          <span class="toast-title">{{ t.title }}</span>
          <span v-if="t.detail" class="toast-detail">{{ t.detail }}</span>
        </div>
        <button type="button" class="toast-close" title="关闭" @click="dismissToast(t.id)">
          <AppIcon name="close" :size="10" />
        </button>
        <!-- 自动关闭倒计时线：时长与 JS 定时器一致，悬停时同步暂停 -->
        <span class="toast-progress" :style="{ animationDuration: `${t.duration}ms` }" />
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped lang="scss">
.toast-region {
  position: fixed;
  top: 10px;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 60; // 高于弹窗遮罩（z-50）
  pointer-events: none; // 只有通知本体可交互，不挡下层点击
}

.toast {
  pointer-events: auto;
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 78%;
  padding: 9px 10px 10px 15px;
  background: #fff;
  border: 1px solid var(--br-card);
  border-radius: 9px;
  box-shadow: 0 8px 28px rgba(33, 41, 51, 0.16);
  overflow: hidden;

  // 类型色条
  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
  }

  &.success::before {
    background: var(--green-solid);
  }

  &.error::before {
    background: var(--red);
  }

  &.warning::before {
    background: var(--amber-icon);
  }

  &.info::before {
    background: var(--blue);
  }
}

.toast-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.toast-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}

.toast-detail {
  font-size: 11px;
  color: var(--text-3);
}

.toast-close {
  width: 20px;
  height: 20px;
  margin-left: 2px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;

  &:hover {
    background: var(--bg-seg);
    color: var(--text-2);
  }
}

// 倒计时线：自右向左收窄，与自动关闭同步
.toast-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: 2px;
  transform-origin: left;
  animation-name: toast-countdown;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

.toast.success .toast-progress {
  background: var(--green-solid);
}

.toast.error .toast-progress {
  background: var(--red);
}

.toast.warning .toast-progress {
  background: var(--amber-icon);
}

.toast.info .toast-progress {
  background: var(--blue);
}

.toast:hover .toast-progress {
  animation-play-state: paused;
}

// 进场：自顶部下滑弹入；离场：淡出上收并脱离文档流让其余通知平滑补位
.toast-enter-active {
  transition: opacity 0.2s ease, transform 0.34s var(--ease-swift);
}

.toast-leave-active {
  transition: opacity 0.16s ease, transform 0.2s var(--ease-quick);
  position: absolute; // 脱离文档流，让 TransitionGroup 的 move 补位动画生效
}

.toast-enter-from {
  opacity: 0;
  transform: translateY(-16px) scale(0.95);
}

.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.97);
}

.toast-move {
  transition: transform 0.3s var(--ease-swift);
}
</style>
