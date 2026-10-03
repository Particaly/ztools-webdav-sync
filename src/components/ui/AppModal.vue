<script setup lang="ts">
import AppIcon from '../AppIcon.vue'

/**
 * 弹窗：遮罩 + 标题栏 + 正文 + 底部操作条。
 * - 标题栏：icon 插槽 + 标题/副标题 + title-extra 插槽（如冲突文件徽标）+ 关闭按钮
 * - 正文布局（flex / gap）由使用方在默认插槽内用工具类自行组织
 * - closeOnMask=false 时点击遮罩不关闭（如冲突弹窗必须显式选择）
 */
withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** 弹窗宽度（px） */
    width?: number
    /** 是否显示右上角关闭按钮 */
    showClose?: boolean
    /** 点击遮罩是否触发 close */
    closeOnMask?: boolean
    /** 底部操作条主轴对齐：end 右对齐 / start 左对齐 */
    footerJustify?: 'start' | 'end'
  }>(),
  { subtitle: undefined, width: undefined, showClose: true, closeOnMask: true, footerJustify: 'end' }
)

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="overlay" @mousedown.self="closeOnMask && emit('close')">
    <div class="modal" :style="width ? { width: `${width}px` } : undefined">
      <div class="modal-titlebar">
        <slot name="icon" />
        <div class="titles">
          <div class="title">{{ title }}</div>
          <div v-if="subtitle" class="subtitle">{{ subtitle }}</div>
        </div>
        <span class="flex-spacer" />
        <slot name="title-extra" />
        <button v-if="showClose" type="button" class="close" @click="emit('close')">
          <AppIcon name="close" :size="12" />
        </button>
      </div>

      <div class="modal-body">
        <slot />
      </div>

      <div v-if="$slots.footer" class="modal-footer" :class="footerJustify === 'end' ? 'justify-end' : 'justify-start'">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.overlay {
  position: absolute;
  inset: 0;
  background: var(--overlay);
  /* 轻磨砂：弹窗与页面内容形成景深层次 */
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.modal {
  background: #fff;
  border: 1px solid var(--br-input);
  border-radius: 10px;
  /* 双层阴影：近处锐利描定轮廓，远处柔和撑起悬浮感 */
  box-shadow:
    0 1px 2px rgba(33, 41, 51, 0.08),
    0 12px 40px rgba(33, 41, 51, 0.18);
  overflow: hidden;
  /* 高度上限：不超过遮罩视口（上下各留 16px），避免弹窗撑破页面导致整页滚动 */
  max-height: calc(100% - 32px);
  display: flex;
  flex-direction: column;
}

.modal-titlebar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px 12px 18px;
  border-bottom: 1px solid var(--br-bar);

  .titles {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-1);
  }

  .subtitle {
    font-size: 11px;
    color: var(--text-3);
  }

  .close {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--text-3);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s ease, color 0.12s ease;

    &:hover {
      background: #f1f3f6;
      color: var(--text-1);
    }
  }
}

.modal-body {
  padding: 16px 18px;
  /* 内容超出弹窗高度时由正文区内部滚动，标题栏与底部操作条保持固定 */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.modal-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 18px;
  background: var(--bg-bar);
  border-top: 1px solid var(--br-bar);
}
</style>
