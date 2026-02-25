<script setup lang="ts">
import { Tooltip } from 'floating-vue'

defineProps<{
  title: string
  nested?: boolean | number
  div?: boolean
  description?: string
  help?: string
  titleClass?: string
  dot?: boolean
}>()

const emit = defineEmits<{
  (event: 'reset'): void
}>()

function reset() {
  emit('reset')
}
</script>

<template>
  <component :is="div ? 'div' : 'label'" flex="~ row gap-2 items-center" select-none>
    <div :class="titleClass || 'w-30'" h-8 flex="~ gap-1 items-center" flex-none min-w-0>
      <div
        v-if="nested" i-ri-corner-down-right-line op40
        :style="typeof nested === 'number' ? { marginLeft: `${nested * 0.5 + 0.5}rem` } : { marginLeft: '0.25rem' }"
      />
      <div v-if="!description" op75 relative inline-flex="~ items-start gap-1" @dblclick="reset">
        <span>{{ title }}</span>
        <Tooltip v-if="help" distance="10">
          <span class="inline-flex items-center justify-center w-4 h-4 rounded-full border border-main op80 text-[10px] cursor-help translate-y-[-0.5rem]">?</span>
          <template #popper>
            <div text-sm min-w-70 v-html="help" />
          </template>
        </Tooltip>
        <div v-if="dot" w-1.5 h-1.5 bg-primary rounded absolute top-0 right--2 />
      </div>
      <Tooltip v-else distance="10">
        <div op75 text-right relative @dblclick="reset">
          {{ title }}
          <div v-if="dot" w-1.5 h-1.5 bg-primary rounded absolute top-0 right--2 />
        </div>
        <template #popper>
          <div text-sm min-w-90 v-html="description" />
        </template>
      </Tooltip>
    </div>
    <slot />
  </component>
</template>
