// 10 种思考动画效果
export interface ThinkingAnimation {
  name: string
  frames: string[]
  label: string
}

export const THINKING_ANIMATIONS: ThinkingAnimation[] = [
  {
    name: 'braille',
    frames: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
    label: '圆点旋转 (默认)',
  },
  {
    name: 'dots',
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    label: '点状波浪',
  },
  {
    name: 'pulse',
    frames: ['◉', '◎', '◉', '◎'],
    label: '脉冲呼吸',
  },
  {
    name: 'arrows',
    frames: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
    label: '箭头旋转',
  },
  {
    name: 'bounce',
    frames: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
    label: '弹跳球',
  },
  {
    name: 'wave',
    frames: ['▁', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃'],
    label: '波浪起伏',
  },
  {
    name: 'circle',
    frames: ['◐', '◓', '◑', '◒'],
    label: '圆环旋转',
  },
  {
    name: 'star',
    frames: ['✶', '✸', '✹', '✺', '✹', '✷'],
    label: '星星闪烁',
  },
  {
    name: 'clock',
    frames: ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'],
    label: '时钟转动',
  },
  {
    name: 'moon',
    frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
    label: '月相变化',
  },
]

export function getAnimation(name: string): ThinkingAnimation {
  return THINKING_ANIMATIONS.find(a => a.name === name) ?? THINKING_ANIMATIONS[0]
}
