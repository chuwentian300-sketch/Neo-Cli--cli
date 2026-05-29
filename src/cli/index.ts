#!/usr/bin/env node

import { Command } from 'commander'
import chalk from 'chalk'
import { loadConfig, initConfig, saveConfig } from '../config/loader.js'
import { MBTI_TYPES, MBTI_LABELS, MBTI_GROUPS, type MbtiType } from '../prompts/mbti.js'
import { THINKING_ANIMATIONS, getAnimation, type ThinkingAnimation } from '../prompts/thinking-animations.js'
import type { AppConfig } from '../config/types.js'
import { DeepSeekAdapter } from '../adapters/deepseek.js'
import { OpenAIAdapter } from '../adapters/openai.js'
import { ClaudeAdapter } from '../adapters/claude.js'
import type { ApiAdapter } from '../adapters/types.js'
import { CacheFirstLoop } from '../core/loop.js'
import { createDefaultToolRegistry } from '../tools/registry.js'
import { SessionManager } from '../session/manager.js'
import { spawn } from 'node:child_process'

const VERSION = '0.1.0'
const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
const SPINNER_MS = 80

// ── ANSI ─────────────────────────────────────────────────────
const write = (s: string) => process.stdout.write(s)
const moveTo = (r: number, c: number) => write(`\x1b[${r};${c}H`)
const hideCur = () => write('\x1b[?25l')
const showCur = () => write('\x1b[?25h')
const eraseLine = () => write('\x1b[2K')
const altScreen = () => write('\x1b[?1049h')
const mainScreen = () => write('\x1b[?1049l')
// 只启用滚轮报告，不禁用选择功能（模仿Claude Code）
const enableMouse = () => { write('\x1b[?1000h'); write('\x1b[?1006h') }
const disableMouse = () => { write('\x1b[?1000l'); write('\x1b[?1006l') }
const rows = () => process.stdout.rows || 30
const cols = () => process.stdout.columns || 80

function createAdapters(config: AppConfig, existing?: Map<string, ApiAdapter>): Map<string, ApiAdapter> {
  const adapters = existing ?? new Map<string, ApiAdapter>()
  adapters.clear()
  const p = config.providers as Record<string, { apiKey?: string; baseUrl?: string } | undefined>
  if (p.deepseek?.apiKey) adapters.set('deepseek', new DeepSeekAdapter({ apiKey: p.deepseek.apiKey, baseUrl: p.deepseek.baseUrl }))
  if (p.openai?.apiKey) adapters.set('openai', new OpenAIAdapter({ apiKey: p.openai.apiKey, baseUrl: p.openai.baseUrl }))
  if (p.claude?.apiKey) adapters.set('claude', new ClaudeAdapter({ apiKey: p.claude.apiKey, baseUrl: p.claude.baseUrl }))
  if (adapters.size === 0) throw new Error('没有配置 API。运行 neo init')
  return adapters
}

// ── 字符显示宽度 ───────────────────────────────────────────
function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!
  if (code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3040 && code <= 0x33bf) ||
    (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6b) || (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x2fa1f)
  )) return 2
  return 1
}

function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

// Strip ANSI escape sequences for width calculation
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// ── 命令定义 ───────────────────────────────────────────────
interface CommandDef {
  name: string
  description: string
}

const COMMANDS: CommandDef[] = [
  { name: '/help', description: '显示帮助信息' },
  { name: '/api', description: '配置 API（地址/Key/模型）' },
  { name: '/mbti', description: '设置性格类型（影响对话风格）' },
  { name: '/thinking', description: '设置思考动画效果' },
  { name: '/copy', description: '复制最后一条AI回复' },
  { name: '/model', description: '显示当前模型' },
  { name: '/mode', description: '切换自动/手动模式' },
  { name: '/clear', description: '清空输出' },
  { name: '/session', description: '显示会话信息' },
  { name: '/resume', description: '恢复历史会话' },
  { name: '/compact', description: '强制压缩上下文' },
  { name: '/cc', description: '打开 cc-connect 消息桥' },
  { name: '/exit', description: '退出' },
]

// ── 全屏管理器 ───────────────────────────────────────────────
class Screen {
  lines: string[] = []
  input = ''
  cursor = 0             // cursor position: 0=end, positive=offset from end
  history: string[] = []
  historyIdx = -1        // -1 = current input, 0..n = history
  isHigh = false
  mode: 'execute' | 'ask' = 'execute'
  processing = false
  thinking = false
  spinIdx = 0
  startTime = 0
  timer: ReturnType<typeof setInterval> | null = null
  scrollY = 0            // scroll offset: 0 = bottom (latest)
  contextRatio = 0       // 0~1, context window usage
  thinkingAnimation: ThinkingAnimation = THINKING_ANIMATIONS[0] // 默认动画
  promptTokens = 0       // 输入 token 数
  thinkingTokens = 0     // 思考 token 数
  completionTokens = 0   // 输出 token 数
  thinkingLabel = '深度思考' // 思考标签
  commandMode = false    // 命令选择模式
  commandIndex = 0       // 当前选中的命令索引
  commandScroll = 0      // 命令列表滚动偏移
  filteredCommands: CommandDef[] = [] // 过滤后的命令列表

  private get statusRow() { return rows() - 4 }
  private get inputRow() { return rows() - 1 }

  accent() { return this.isHigh ? '\x1b[38;2;240;150;50m' : '\x1b[38;2;70;130;230m' }

  contextBar(): string {
    const pct = Math.round(this.contextRatio * 100)
    const R = '\x1b[0m'
    const BLOCKS = ['░', '▒', '▓', '█']
    // 8-char bar: each char maps to 12.5% range
    let bar = ''
    for (let i = 0; i < 8; i++) {
      const threshold = (i + 1) * 12.5
      if (pct >= threshold) bar += BLOCKS[3]       // █ full
      else if (pct >= threshold - 6) bar += BLOCKS[2]  // ▓
      else if (pct >= threshold - 10) bar += BLOCKS[1] // ▒
      else bar += BLOCKS[0]                         // ░ empty
    }
    // Color: green < 50%, yellow 50-75%, red > 75%
    const r = pct > 75 ? 255 : pct > 50 ? Math.round(255 * (pct - 50) / 25) : 80
    const g = pct > 75 ? Math.round(200 * (100 - pct) / 25) : pct > 50 ? 200 : 200
    const b = 80
    return `\x1b[38;2;${r};${g};${b}m${bar} ${pct}%${R}`
  }

  addLine(line: string) {
    this.lines.push(line)
    this.scrollY = 0   // new content → snap to bottom
  }

  scroll(delta: number) {
    const outputEndRow = this.statusRow - (this.commandMode ? Math.min(6, this.filteredCommands.length) : 0)
    const maxVisible = outputEndRow - 2
    const maxScroll = Math.max(0, this.lines.length - maxVisible)
    this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY + delta))
    this.render()
  }

  render() {
    const r = rows(), c = cols()
    const a = this.accent()
    const R = '\x1b[0m', D = '\x1b[2m', BD = '\x1b[1m'
    const G = '\x1b[38;2;80;200;120m'
    const C = '\x1b[38;2;0;200;200m'
    const tag = ` ${this.mode === 'execute' ? '执行' : '询问'} `

    hideCur()

    // Header
    moveTo(1, 1); eraseLine()
    const headerExtra = this.scrollY > 0 ? `${D}  ↑ ${this.scrollY} lines${R}` : ''
    write(`${BD}  NEO-CLI${R}${D}  v${VERSION}${R}${headerExtra}`)

    // Output area (row 2 ~ palette/status boundary)
    const paletteHeight = this.commandMode ? Math.min(6, this.filteredCommands.length) : 0
    const outputEndRow = this.statusRow - paletteHeight
    const maxVisible = outputEndRow - 2
    const maxW = c - 2

    // Compute visible window: bottom-aligned, offset by scrollY
    const endIdx = this.lines.length - this.scrollY
    const startIdx = Math.max(0, endIdx - maxVisible)
    const visible = this.lines.slice(startIdx, endIdx)

    for (let i = 0; i < maxVisible; i++) {
      moveTo(2 + i, 1); eraseLine()
      if (i < visible.length) {
        const raw = visible[i]
        // Truncate by display width, not char count
        let w = 0
        let out = ''
        for (const ch of stripAnsi(raw)) {
          const cw = charWidth(ch)
          if (w + cw > maxW) break
          out += ch
          w += cw
        }
        // Write original (with ANSI codes) truncated to same char position
        write(raw.length > out.length ? raw.slice(0, out.length + (raw.length - stripAnsi(raw).length)) : raw)
      }
    }

    // Command palette (above input box, only when active)
    if (this.commandMode && this.filteredCommands.length > 0) {
      const maxPalette = 6
      const maxShow = Math.min(maxPalette, this.filteredCommands.length)
      const paletteStartRow = this.statusRow - maxPalette + 1
      for (let i = 0; i < maxPalette; i++) {
        moveTo(paletteStartRow + i, 1); eraseLine()
        if (i < maxShow) {
          const cmdIdx = this.commandScroll + i
          const cmd = this.filteredCommands[cmdIdx]
          const selected = cmdIdx === this.commandIndex
          const indicator = selected ? '\x1b[1;37m❯\x1b[0m' : ' '
          const nameColor = selected ? '\x1b[1;37m' : '\x1b[2m'
          const descColor = selected ? '\x1b[0m' : '\x1b[2m'
          const bgColor = selected ? '\x1b[48;2;40;40;60m' : ''
          const resetBg = selected ? '\x1b[0m' : ''
          write(`  ${indicator} ${bgColor}${nameColor}${cmd.name}\x1b[0m  ${descColor}${cmd.description}${resetBg}`)
        }
      }
    }
    // Clear gap row between palette and input box
    moveTo(r - 3, 1); eraseLine()

    // Status line (thinking indicator) — only when palette is NOT shown
    if (!this.commandMode) {
      moveTo(this.statusRow, 1); eraseLine()
      if (this.processing) {
        const frames = this.thinkingAnimation.frames
        const dotPatterns = ['   ', '.  ', '.. ', '...']
        const dots = dotPatterns[this.spinIdx % dotPatterns.length]
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1)
        const parts = [`${elapsed}s`]
        if (this.promptTokens > 0) parts.push(`↓ ${this.promptTokens} tokens`)
        if (this.thinkingTokens > 0) parts.push(`thought for ${this.thinkingTokens}`)
        const info = parts.length > 0 ? ` (${parts.join(' · ')})` : ''
        const label = this.thinking ? this.thinkingLabel : '处理中'
        write(`${D}  ${frames[this.spinIdx % frames.length]} ${label}${dots}${C}${info}${R}`)
      }
    }

    // Input box - top border
    const ctxBar = this.contextBar()
    const ctxBarW = 12  // "░░░░░░░░ 99%" = 8+1+2-1=12 display cols (no ANSI)
    const topFill = Math.max(0, c - 2 - tag.length - ctxBarW - 1)
    moveTo(r - 2, 1); eraseLine()
    write(`${a}${B.tl}${B.h.repeat(topFill)}${tag}${ctxBar} ${R}`)

    // Input content line
    const prompt = this.processing
      ? `${this.thinkingAnimation.frames[this.spinIdx % this.thinkingAnimation.frames.length]} `
      : '❯ '
    const elapsed = this.processing ? ` ${((Date.now() - this.startTime) / 1000).toFixed(1)}s` : ''

    const promptW = strWidth(prompt)
    const elapsedW = strWidth(elapsed)
    const maxInputW = c - 4 - promptW - elapsedW

    // Cursor position: cursor=0 means end, cursor>means offset from end
    const cursorPos = Math.max(0, this.input.length - this.cursor)

    // Compute display window, scrolling to keep cursor visible
    let displayStart = 0
    let display = this.input
    let displayW = strWidth(display)

    // Scroll input window to keep cursor in view
    if (displayW > maxInputW) {
      // Find the start position that keeps cursor visible
      const cursorCol = strWidth(this.input.slice(0, cursorPos))
      const visibleStart = Math.max(0, cursorCol - maxInputW + 10)
      let accW = 0
      for (let i = 0; i < this.input.length; i++) {
        if (accW >= visibleStart) { displayStart = i; break }
        accW += charWidth(this.input[i])
      }
      display = this.input.slice(displayStart)
      displayW = strWidth(display)
      while (displayW > maxInputW && display.length > 0) {
        display = display.slice(1)
        displayStart++
        displayW = strWidth(display)
      }
    }

    const pad = Math.max(0, c - 4 - promptW - displayW - elapsedW)

    // Build display with cursor highlight
    const relCursor = cursorPos - displayStart
    const INV = '\x1b[7m'  // reverse video for cursor
    let displayWithCursor: string
    if (!this.processing && relCursor >= 0 && relCursor < display.length) {
      const before = display.slice(0, relCursor)
      const at = display[relCursor]
      const after = display.slice(relCursor + 1)
      displayWithCursor = `${before}${INV}${at}${R}${after}`
    } else {
      displayWithCursor = display
    }

    moveTo(this.inputRow, 1); eraseLine()
    write(`${a}${B.v}${R} ${G}${prompt}${R}${displayWithCursor}${' '.repeat(pad)}${C}${elapsed}${R} ${a}${B.v}${R}`)

    // Bottom border
    moveTo(r, 1); eraseLine()
    write(`${a}${B.bl}${B.h.repeat(c - 2)}${B.br}${R}`)

    // Terminal cursor position
    if (!this.processing) {
      const cursorCol = 3 + promptW + strWidth(display.slice(0, Math.max(0, relCursor)))
      moveTo(this.inputRow, Math.min(cursorCol, c - 2))
      showCur()
    }
  }

  startSpin() {
    this.processing = true
    this.thinking = true
    this.startTime = Date.now()
    this.spinIdx = 0
    this.promptTokens = 0
    this.thinkingTokens = 0
    this.completionTokens = 0
    this.timer = setInterval(() => { this.spinIdx++; this.render() }, SPINNER_MS)
    this.render()
  }

  stopSpin() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1)
    this.processing = false
    this.thinking = false
    return elapsed
  }

  showResponse() {
    this.thinking = false
    this.render()
  }

  moveLeft() {
    if (this.cursor < this.input.length) { this.cursor++; this.render() }
  }

  moveRight() {
    if (this.cursor > 0) { this.cursor--; this.render() }
  }

  historyUp() {
    if (this.history.length === 0) return
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++
      this.input = this.history[this.history.length - 1 - this.historyIdx]
      this.cursor = 0
      this.render()
    }
  }

  historyDown() {
    if (this.historyIdx > 0) {
      this.historyIdx--
      this.input = this.history[this.history.length - 1 - this.historyIdx]
      this.cursor = 0
      this.render()
    } else if (this.historyIdx === 0) {
      this.historyIdx = -1
      this.input = ''
      this.cursor = 0
      this.render()
    }
  }

  pushHistory(text: string) {
    if (text && (this.history.length === 0 || this.history[this.history.length - 1] !== text)) {
      this.history.push(text)
    }
    this.historyIdx = -1
  }

  // 命令过滤
  updateCommands() {
    if (!this.input.startsWith('/')) {
      this.commandMode = false
      this.filteredCommands = []
      return
    }
    const query = this.input.toLowerCase()
    this.filteredCommands = COMMANDS.filter(cmd => cmd.name.startsWith(query))
    this.commandMode = this.filteredCommands.length > 0
    this.commandIndex = 0
    this.commandScroll = 0
  }

  // 选择上一个命令
  commandUp() {
    if (!this.commandMode) return
    this.commandIndex = Math.max(0, this.commandIndex - 1)
    // 滚动跟随选中项
    if (this.commandIndex < this.commandScroll) this.commandScroll = this.commandIndex
    this.render()
  }

  // 选择下一个命令
  commandDown() {
    if (!this.commandMode) return
    this.commandIndex = Math.min(this.filteredCommands.length - 1, this.commandIndex + 1)
    // 滚动跟随选中项
    const maxVisible = 6
    if (this.commandIndex >= this.commandScroll + maxVisible) this.commandScroll = this.commandIndex - maxVisible + 1
    this.render()
  }

  // 确认选择命令
  confirmCommand(): string | null {
    if (!this.commandMode || this.filteredCommands.length === 0) return null
    const cmd = this.filteredCommands[this.commandIndex]
    this.input = cmd.name + ' '
    this.cursor = 0
    this.commandMode = false
    this.filteredCommands = []
    this.commandScroll = 0
    this.render()
    return cmd.name
  }

  // 取消命令选择
  cancelCommand() {
    this.commandMode = false
    this.filteredCommands = []
    this.commandScroll = 0
    this.render()
  }

  exit() {
    if (this.timer) clearInterval(this.timer)
    disableMouse()
    mainScreen()
  }
}

// ── 交互模式 ─────────────────────────────────────────────────
async function interactiveMode(config: AppConfig, initialPrompt?: string): Promise<void> {
  let adapters = createAdapters(config)
  const { registry, defs } = createDefaultToolRegistry()
  const session = new SessionManager()
  await session.init()
  let { id } = session.createSession()
  let logPath = session.getLogPath(id)
  await session.saveMeta({ id, createdAt: Date.now(), updatedAt: Date.now(), turnCount: 0, totalCost: 0 })

  let abortController = new AbortController()
  let loop = new CacheFirstLoop({
    adapters, config, tools: defs, toolRegistry: registry, sessionPath: logPath, abortSignal: abortController.signal,
  })

  const scr = new Screen()
  scr.thinkingAnimation = getAnimation(config.thinkingAnimation || 'braille')
  altScreen()
  enableMouse()
  write('\x1b[2J\x1b[H')

  scr.addLine(chalk.dim(`  session: ${id}  │  TAB 切换模式  │  /help 帮助`))
  scr.addLine('')
  scr.render()

  const accent = () => scr.isHigh ? chalk.hex('#f09632') : chalk.hex('#4682e6')

  // ── 处理输入 ──
  const processInput = async (input: string) => {
    taskAborted = false
    abortController = new AbortController()
    loop = new CacheFirstLoop({
      adapters, config, tools: defs, toolRegistry: registry, sessionPath: logPath, abortSignal: abortController.signal,
    })
    scr.startSpin()

    // 判断问题复杂度（简单问题直接判断，中等/复杂根据工具调用次数）
    const simplePatterns = /^(你好|hi|hello|ok|好的|是的|嗯|谢谢|thanks|bye|再见|1\+1|今天|现在|什么是)/i
    if (simplePatterns.test(input) && input.length < 20) {
      scr.thinkingLabel = '简单思考'
    } else {
      scr.thinkingLabel = '有点意思'  // 默认中等，工具调用>3次时升级为深度思考
    }

    scr.addLine(chalk.bold.green('  You │') + ` ${input}`)

    let aiStarted = false
    let toolSection = false
    let gotDone = false
    let gotError = false
    let gotTextAfterTools = false
    let round = 0
    let toolCallCount = 0  // 工具调用计数
    let lastEventTime = Date.now()

    // Timeout watchdog: if no event for 120s, warn user
    const timeoutTimer = setInterval(() => {
      if (Date.now() - lastEventTime > 120_000) {
        scr.addLine(chalk.yellow(`  ⚠ 已 120 秒无响应，流可能中断`))
        scr.render()
        lastEventTime = Date.now()  // reset to avoid spam
      }
    }, 30_000)

    const ensureAiLine = () => {
      if (!aiStarted) {
        scr.addLine('')
        aiStarted = true
        toolSection = false
      }
    }

    try {
      for await (const event of loop.step(input)) {
        if (taskAborted) break
        lastEventTime = Date.now()
        scr.contextRatio = loop.getContextUsage()
        switch (event.type) {
          case 'text':
            if (scr.thinking) scr.showResponse()
            if (toolSection) { aiStarted = false; toolSection = false; gotTextAfterTools = true }
            ensureAiLine()
            // Split by newlines: first part appends to current line, rest become new lines
            const parts = event.content.split('\n')
            scr.lines[scr.lines.length - 1] += parts[0]
            for (let i = 1; i < parts.length; i++) {
              scr.addLine(parts[i])
            }
            scr.render()
            break

          case 'reasoning':
            // 估算 thinking tokens (约 3.5 字符 = 1 token)
            scr.thinkingTokens += Math.ceil((event.content?.length || 0) / 3.5)
            break

          case 'model_switch':
            scr.isHigh = event.model === config.models.high.id
            if (aiStarted) scr.addLine('')
            scr.addLine(chalk.dim(`  ⟳ ${event.model}`))
            aiStarted = false
            round++
            scr.render()
            break

          case 'tool_start':
            if (scr.thinking) scr.showResponse()
            if (!toolSection) {
              if (aiStarted) scr.addLine('')
              toolSection = true
            }
            // 工具调用计数，超过3次升级为深度思考
            toolCallCount++
            if (toolCallCount > 3 && scr.thinkingLabel !== '简单思考') {
              scr.thinkingLabel = '深度思考'
            }
            // 工具名称中文映射
            {
              const toolNames: Record<string, string> = {
                'read_file': '读取文件',
                'write_file': '写入文件',
                'edit_file': '编辑文件',
                'run_command': '执行命令',
                'grep': '搜索内容',
                'glob': '查找文件',
              }
              const displayName = toolNames[event.name] || event.name
              scr.addLine(`  \x1b[1;37m⏺\x1b[0m ${displayName}`)
            }
            scr.render()
            break

          case 'tool_end': {
            const lastIdx = scr.lines.length - 1
            const toolNames: Record<string, string> = {
              'read_file': '读取文件',
              'write_file': '写入文件',
              'edit_file': '编辑文件',
              'run_command': '执行命令',
              'grep': '搜索内容',
              'glob': '查找文件',
            }
            const displayName = toolNames[event.name] || event.name
            // 成功：绿色⎿
            scr.lines[lastIdx] = `  \x1b[1;32m⎿\x1b[0m ${displayName}`
            scr.render()
            break
          }

          case 'fold':
            scr.addLine(chalk.dim(`  ⤵ 历史压缩`))
            scr.render()
            break

          case 'usage': {
            // 只更新token计数，不显示usage统计（模仿Claude Code）
            scr.promptTokens = event.prompt
            scr.completionTokens = event.completion
            break
          }

          case 'error':
            gotError = true
            if (scr.thinking) scr.showResponse()
            scr.addLine(chalk.red(`  ✗ ${event.message}`))
            scr.render()
            break

          case 'done': {
            gotDone = true
            if (scr.thinking) scr.showResponse()
            // 不重复显示AI回复（模仿Claude Code）
            break
          }
        }
      }
    } catch (err: any) {
      if (scr.thinking) scr.showResponse()
      scr.addLine(chalk.red(`  ✗ 流中断: ${err.message}`))
      scr.render()
    } finally {
      clearInterval(timeoutTimer)
    }

    // Stream ended without done event → likely truncated or connection lost
    if (!gotDone && !gotError) {
      scr.addLine(chalk.yellow(`  ⚠ 响应可能不完整（流未正常结束）`))
      scr.render()
    }

    // Model used tools but never generated text after → likely hit output limit
    if (toolSection && !gotTextAfterTools) {
      scr.addLine(chalk.yellow(`  ⚠ 模型未生成回复文本（可能达到输出上限）`))
      scr.render()
    }

    const elapsed = scr.stopSpin()

    if (scr.mode === 'ask') {
      scr.addLine(chalk.hex('#f09632')('  [询问] 仅回答问题，不修改代码'))
    }

    // 构建统计信息
    const parts = [`${elapsed}s`]
    if (scr.promptTokens > 0) parts.push(`↓ ${scr.promptTokens} tokens`)
    if (scr.thinkingTokens > 0) parts.push(`thought for ${scr.thinkingTokens}`)
    const stats = parts.join(' · ')
    scr.addLine(chalk.dim(`  ⎿ ${stats}`))
    scr.addLine('')
    scr.render()

    // Update session meta after each turn
    session.saveMeta({
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCount: loop.stats.turns,
      totalCost: loop.stats.totalCost,
    }).catch(() => {})
  }

  // ── 首次 MBTI 设置 ──
  if (!config.mbti) {
    scr.addLine(chalk.bold('  ── 设置你的 MBTI 性格类型 ──'))
    scr.addLine(chalk.dim('  AI 会根据你的性格调整沟通风格'))
    scr.addLine('')
    for (const g of MBTI_GROUPS) {
      const items = g.types.map(t => `${t} ${MBTI_LABELS[t]}`).join('  ')
      scr.addLine(chalk.dim(`  ${g.name}`))
      scr.addLine(chalk.dim(`  ${items}`))
    }
    scr.addLine('')
    scr.addLine(chalk.cyan('  输入你的 MBTI 类型'))
    scr.addLine(chalk.dim('  例如: INTJ, ENFP, ISTP'))
    scr.addLine(chalk.dim('  > '))
    scr.render()

    const mbtiResult = await new Promise<string>((resolve) => {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf-8')
      let buf = ''
      const onData = (key: string) => {
        const code = key.charCodeAt(0)
        if (code === 0x0d || code === 0x0a) {
          process.stdin.removeListener('data', onData)
          process.stdin.setRawMode(false)
          resolve(buf.trim())
          return
        }
        if (code === 0x1b && key.length >= 3) return
        if (code === 0x03) { scr.exit(); process.exit(0) }
        if (code === 0x7f || code === 0x08) {
          buf = buf.slice(0, -1)
          scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + buf
          scr.render()
          return
        }
        if (code >= 0x20) {
          buf += key
          scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + buf
          scr.render()
        }
      }
      process.stdin.on('data', onData)
    })

    const mbtiUpper = mbtiResult.toUpperCase().trim()
    if (MBTI_TYPES.includes(mbtiUpper as any)) {
      const cfg = await loadConfig()
      cfg.mbti = mbtiUpper
      await saveConfig(cfg)
      Object.assign(config, cfg)
      loop.setMbti(mbtiUpper)
      scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + chalk.green(`${mbtiUpper}（${MBTI_LABELS[mbtiUpper as MbtiType]}）`) + chalk.dim(' ✓')
      scr.addLine(chalk.green('  ✓ 性格已设置'))
    } else if (mbtiResult) {
      scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + chalk.dim(`${mbtiResult}（跳过，稍后可用 /mbti 设置）`)
    } else {
      scr.lines[scr.lines.length - 1] = chalk.dim('  > (跳过，稍后可用 /mbti 设置)')
    }
    scr.addLine('')
    scr.render()
  }

  if (initialPrompt) await processInput(initialPrompt)

  // ── 键盘 ──
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf-8')
  let locked = false
  let wizardMode = false
  let taskAborted = false

  const abortTask = () => {
    taskAborted = true
    abortController.abort()
    scr.stopSpin()
    scr.addLine(chalk.yellow('  ⏹ 已中断'))
    scr.render()
  }

  // 调试：检查ESC是否被触发
  const debugEsc = () => {
    scr.addLine(chalk.dim(`  [DEBUG] ESC pressed, processing=${scr.processing}`))
    scr.render()
  }

  process.stdin.on('data', async (key: string) => {
    if (locked || wizardMode) return
    const code = key.charCodeAt(0)

    // ESC alone (not an escape sequence) → abort task or clear input
    if (code === 0x1b) {
      // 检查是否是单独的ESC键（不是转义序列）
      const isEscapeSequence = key.length > 1 && (key[1] === '[' || key[1] === 'O')
      if (!isEscapeSequence) {
        debugEsc()
        if (scr.processing) { abortTask(); return }
        scr.input = ''
        scr.cursor = 0
        scr.render()
        return
      }
    }

    if (scr.processing) return

    // Mouse events (SGR mode): \x1b[<button;col;rowM/m
    if (key.startsWith('\x1b[<')) {
      const match = key.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/)
      if (match) {
        const button = parseInt(match[1])
        // Scroll up (button 64) / down (button 65)
        if (button === 64) { scr.scroll(3); return }
        if (button === 65) { scr.scroll(-3); return }
      }
      return
    }

    // Helper: wait for single-line input (used by /api and /mbti)
    const askInline = (label: string, hint: string): Promise<string> => {
      scr.addLine(chalk.cyan(`  ${label}`))
      if (hint) scr.addLine(chalk.dim(`  ${hint}`))
      scr.addLine(chalk.dim('  > '))
      scr.render()

      return new Promise<string>((resolve) => {
        wizardMode = true
        let buf = ''
        const onData = (key: string) => {
          const code = key.charCodeAt(0)
          if (code === 0x0d || code === 0x0a) {
            process.stdin.removeListener('data', onData)
            wizardMode = false
            resolve(buf.trim())
            return
          }
          if (code === 0x1b && key.length >= 3) return
          if (code === 0x03) { wizardMode = false; scr.exit(); process.exit(0) }
          if (code === 0x7f || code === 0x08) {
            buf = buf.slice(0, -1)
            scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + buf
            scr.render()
            return
          }
          if (code >= 0x20) {
            buf += key
            scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + buf
            scr.render()
          }
        }
        process.stdin.on('data', onData)
      })
    }

    // TAB / SHIFT+TAB
    if (code === 0x09 || (code === 0x1b && key.length >= 3 && key.slice(1, 3) === '[Z')) {
      scr.mode = scr.mode === 'execute' ? 'ask' : 'execute'
      loop.setMode(scr.mode)
      scr.render()
      return
    }

    // Arrow keys + Page Up/Down
    if (code === 0x1b && key.length >= 3) {
      const seq = key.slice(1)
      if (seq === '[C') { scr.moveRight(); return }    // Right → cursor forward
      if (seq === '[D') { scr.moveLeft(); return }     // Left → cursor back
      if (seq === '[A') {                            // Up → command select or history
        if (scr.commandMode) { scr.commandUp(); return }
        scr.historyUp(); return
      }
      if (seq === '[B') {                            // Down → command select or history
        if (scr.commandMode) { scr.commandDown(); return }
        scr.historyDown(); return
      }
      if (seq === '[5~') { scr.scroll(10); return }   // Page Up → scroll output
      if (seq === '[6~') { scr.scroll(-10); return }  // Page Down → scroll output
      if (seq === '[H') { scr.cursor = scr.input.length; scr.render(); return } // Home
      if (seq === '[F') { scr.cursor = 0; scr.render(); return }                // End
      if (seq === '[3~') { // Delete
        const pos = scr.input.length - scr.cursor
        if (pos < scr.input.length) {
          scr.input = scr.input.slice(0, pos) + scr.input.slice(pos + 1)
          scr.updateCommands()
          scr.render()
        }
        return
      }
      // 如果不是已知的转义序列，可能是ESC键
      if (scr.processing) { abortTask(); return }
      if (scr.commandMode) { scr.cancelCommand(); return }
      scr.input = ''
      scr.cursor = 0
      scr.render()
      return
    }

    // Enter
    if (code === 0x0d || code === 0x0a) {
      // 命令选择模式：确认选择
      if (scr.commandMode) {
        scr.confirmCommand()
        return
      }

      const input = scr.input.trim()
      if (!input) return
      scr.pushHistory(input)
      scr.input = ''
      scr.cursor = 0

      // Slash commands
      if (input.startsWith('/')) {
        const [cmd, ...args] = input.slice(1).toLowerCase().split(/\s+/)
        switch (cmd) {
          case 'help':
          case 'h':
            scr.addLine(chalk.bold('  命令列表：'))
            scr.addLine(chalk.dim('  /help      显示此帮助'))
            scr.addLine(chalk.dim('  /api       配置 API（地址/Key/模型）'))
            scr.addLine(chalk.dim('  /mbti      设置性格类型（影响对话风格）'))
            scr.addLine(chalk.dim('  /thinking  设置思考动画效果'))
            scr.addLine(chalk.dim('  /copy      复制最后一条AI回复'))
            scr.addLine(chalk.dim('  /model     显示当前模型'))
            scr.addLine(chalk.dim('  /mode      切换自动/手动模式'))
            scr.addLine(chalk.dim('  /clear     清空输出'))
            scr.addLine(chalk.dim('  /session   显示会话信息'))
            scr.addLine(chalk.dim('  /resume    恢复历史会话'))
            scr.addLine(chalk.dim('  /compact   强制压缩上下文'))
            scr.addLine(chalk.dim('  /cc        打开 cc-connect 消息桥'))
            scr.addLine(chalk.dim('  /exit      退出'))
            scr.addLine('')
            scr.render()
            return
          case 'model':
            scr.addLine(chalk.dim(`  高级模型: ${config.models.high.id} (${config.models.high.provider})`))
            scr.addLine(chalk.dim(`  低级模型: ${config.models.low.id} (${config.models.low.provider})`))
            scr.addLine('')
            scr.render()
            return
          case 'mbti': {
            const curMbti = config.mbti
            scr.addLine(chalk.bold('  ── MBTI 性格设置 ──'))
            if (curMbti) scr.addLine(chalk.dim(`  当前: ${curMbti}（${MBTI_LABELS[curMbti as MbtiType]}）`))
            scr.addLine('')
            for (const g of MBTI_GROUPS) {
              const items = g.types.map(t => `${t} ${MBTI_LABELS[t]}`).join('  ')
              scr.addLine(chalk.dim(`  ${g.name}`))
              scr.addLine(chalk.dim(`  ${items}`))
            }
            scr.addLine('')
            const mbtiInput = await askInline('输入你的 MBTI 类型', '例如: INTJ, ENFP, ISTP')
            const mbtiUpper = mbtiInput.toUpperCase().trim()
            if (MBTI_TYPES.includes(mbtiUpper as any)) {
              const cfg = await loadConfig()
              cfg.mbti = mbtiUpper
              await saveConfig(cfg)
              Object.assign(config, cfg)
              loop.setMbti(mbtiUpper)
              scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + chalk.green(`${mbtiUpper}（${MBTI_LABELS[mbtiUpper as MbtiType]}）`) + chalk.dim(' ✓')
              scr.addLine(chalk.green('  ✓ 性格已设置，对话风格已更新'))
            } else if (mbtiInput) {
              scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + chalk.red(mbtiInput) + chalk.dim(' ✗')
              scr.addLine(chalk.red('  ✗ 无效的 MBTI 类型'))
            } else {
              scr.lines[scr.lines.length - 1] = chalk.dim('  > (跳过)')
            }
            scr.addLine('')
            scr.render()
            return
          }
          case 'thinking': {
            const curAnim = config.thinkingAnimation || 'braille'
            scr.addLine(chalk.bold('  ── 思考动画设置 ──'))
            scr.addLine(chalk.dim(`  当前: ${getAnimation(curAnim).label}`))
            scr.addLine('')
            for (let i = 0; i < THINKING_ANIMATIONS.length; i++) {
              const a = THINKING_ANIMATIONS[i]
              const marker = a.name === curAnim ? chalk.green(' ● ') : '   '
              scr.addLine(chalk.dim(`  ${marker}${i + 1}. ${a.frames[0]} ${a.label}`))
            }
            scr.addLine('')
            const animInput = await askInline('输入序号选择动画', `1-${THINKING_ANIMATIONS.length}`)
            const animIdx = parseInt(animInput, 10) - 1
            if (animIdx >= 0 && animIdx < THINKING_ANIMATIONS.length) {
              const selected = THINKING_ANIMATIONS[animIdx]
              const cfg = await loadConfig()
              cfg.thinkingAnimation = selected.name
              await saveConfig(cfg)
              Object.assign(config, cfg)
              scr.thinkingAnimation = selected
              scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + chalk.green(`${selected.frames[0]} ${selected.label}`) + chalk.dim(' ✓')
              scr.addLine(chalk.green('  ✓ 思考动画已更新'))
            } else if (animInput) {
              scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + chalk.red(animInput) + chalk.dim(' ✗')
              scr.addLine(chalk.red('  ✗ 无效序号'))
            } else {
              scr.lines[scr.lines.length - 1] = chalk.dim('  > (跳过)')
            }
            scr.addLine('')
            scr.render()
            return
          }
          case 'mode':
            scr.mode = scr.mode === 'execute' ? 'ask' : 'execute'
            loop.setMode(scr.mode)
            scr.addLine(chalk.dim(`  模式已切换为: ${scr.mode === 'execute' ? '执行' : '询问'}`))
            scr.addLine('')
            scr.render()
            return
          case 'clear':
            scr.lines = []
            scr.scrollY = 0
            scr.addLine(chalk.dim(`  session: ${id}  │  TAB 切换模式  │  /help 帮助`))
            scr.addLine('')
            scr.render()
            return
          case 'session':
            scr.addLine(chalk.dim(`  会话 ID: ${id}`))
            scr.addLine(chalk.dim(`  日志路径: ${logPath}`))
            scr.addLine(chalk.dim(`  消息数: ${loop.stats.messages}`))
            scr.addLine(chalk.dim(`  轮次: ${loop.stats.turns}`))
            scr.addLine(chalk.dim(`  总花费: $${loop.stats.totalCost.toFixed(4)}`))
            scr.addLine(chalk.dim(`  上下文: ${Math.round(loop.getContextUsage() * 100)}%`))
            scr.addLine('')
            scr.render()
            return
          case 'resume': {
            const recent = await session.listRecent(10)
            if (recent.length === 0) {
              scr.addLine(chalk.dim('  没有历史会话'))
              scr.addLine('')
              scr.render()
              return
            }
            scr.addLine(chalk.bold('  ── 历史会话 ──'))
            for (let i = 0; i < recent.length; i++) {
              const s = recent[i]
              const date = new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
              const cost = s.totalCost > 0 ? ` $${s.totalCost.toFixed(4)}` : ''
              scr.addLine(chalk.dim(`  ${i + 1}. ${date}  ${s.turnCount}轮  ${cost}  ${s.id.slice(0, 20)}...`))
            }
            scr.addLine('')
            const choice = await askInline('输入序号恢复会话', `1-${recent.length}`)
            const idx = parseInt(choice, 10) - 1
            if (idx >= 0 && idx < recent.length) {
              const target = recent[idx]
              id = target.id
              logPath = session.getLogPath(id)
              loop = new CacheFirstLoop({
                adapters, config, tools: defs, toolRegistry: registry, sessionPath: logPath,
              })
              await loop.loadSession()

              // Display restored history
              scr.lines = []
              scr.scrollY = 0
              scr.addLine(chalk.dim(`  session: ${id}  │  已恢复 ${loop.stats.messages} 条消息  │  ${loop.stats.turns} 轮`))
              scr.addLine('')

              // Show last few messages from history
              const entries = loop.getRecentEntries(6)
              for (const entry of entries) {
                const msg = entry.message
                const content = typeof msg.content === 'string' ? msg.content : ''
                const preview = content.replace(/\n/g, ' ').slice(0, 80)
                if (msg.role === 'user') {
                  scr.addLine(chalk.bold.green('  You │') + ` ${preview}`)
                } else if (msg.role === 'assistant') {
                  scr.addLine(accent().bold('  AI  │') + ` ${preview}`)
                } else if (msg.role === 'tool') {
                  scr.addLine(chalk.dim(`  ⚙ ${preview}`))
                }
              }
              scr.addLine(chalk.green(`  ✓ 会话已恢复`))
            } else if (choice) {
              scr.addLine(chalk.red('  ✗ 无效序号'))
            } else {
              scr.addLine(chalk.dim('  已取消'))
            }
            scr.addLine('')
            scr.render()
            return
          }
          case 'compact':
            scr.addLine(chalk.dim('  正在压缩上下文...'))
            scr.render()
            // Trigger a fold by faking a high ratio
            for await (const event of loop.step('请压缩之前的对话历史，保留关键信息')) {
              if (event.type === 'text') {
                scr.addLine(accent().bold('  AI  │') + ' ' + event.content)
                scr.render()
              }
              if (event.type === 'fold') {
                scr.addLine(chalk.dim('  ⤵ 上下文已压缩'))
                scr.render()
              }
            }
            scr.addLine(chalk.dim('  压缩完成'))
            scr.addLine('')
            scr.render()
            return
          case 'copy': {
            // 获取最后一条AI回复
            const entries = loop.getRecentEntries(10)
            const lastAiEntry = [...entries].reverse().find(e => e.message.role === 'assistant')
            if (!lastAiEntry) {
              scr.addLine(chalk.dim('  没有可复制的AI回复'))
              scr.addLine('')
              scr.render()
              return
            }
            const content = typeof lastAiEntry.message.content === 'string'
              ? lastAiEntry.message.content
              : ''

            // 复制到剪贴板
            try {
              const { execSync } = await import('node:child_process')
              if (process.platform === 'win32') {
                // Windows: 使用 clip.exe
                execSync('clip', { input: Buffer.from(content, 'utf-16le') })
              } else if (process.platform === 'darwin') {
                // macOS: 使用 pbcopy
                execSync('pbcopy', { input: Buffer.from(content, 'utf-8') })
              } else {
                // Linux: 使用 xclip
                execSync('xclip -selection clipboard', { input: Buffer.from(content, 'utf-8') })
              }
              scr.addLine(chalk.green('  ✓ 已复制到剪贴板'))
            } catch {
              // 如果剪贴板命令失败，显示内容让用户手动复制
              scr.addLine(chalk.dim('  复制失败，请手动复制以下内容：'))
              scr.addLine('')
              scr.addLine(content)
            }
            scr.addLine('')
            scr.render()
            return
          }
          case 'api': {
            // Helper: wait for single-line input
            const askField = async (label: string, hint: string): Promise<string> => {
              scr.addLine(chalk.cyan(`  ${label}`))
              if (hint) scr.addLine(chalk.dim(`  ${hint}`))
              scr.addLine(chalk.dim('  > '))
              scr.render()

              return new Promise<string>((resolve) => {
                wizardMode = true
                let buf = ''
                const onData = (key: string) => {
                  const code = key.charCodeAt(0)
                  if (code === 0x0d || code === 0x0a) {
                    process.stdin.removeListener('data', onData)
                    wizardMode = false
                    resolve(buf.trim())
                    return
                  }
                  if (code === 0x1b && key.length >= 3) return
                  if (code === 0x03) { wizardMode = false; scr.exit(); process.exit(0) }
                  if (code === 0x7f || code === 0x08) {
                    buf = buf.slice(0, -1)
                    scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + buf
                    scr.render()
                    return
                  }
                  if (code >= 0x20) {
                    buf += key
                    scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + buf
                    scr.render()
                  }
                }
                process.stdin.on('data', onData)
              })
            }

            const PRESETS: Record<string, { url: string; models: string[] }> = {
              '1': { url: 'https://api.deepseek.com', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3', 'deepseek-r1'] },
              '2': { url: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1'] },
              '3': { url: 'https://api.anthropic.com/v1', models: ['claude-opus-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
              '4': { url: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'] },
              '5': { url: 'http://localhost:11434/v1', models: ['llama3', 'qwen2.5', 'deepseek-r1'] },
            }

            const cfg = await loadConfig()
            const curProvider = cfg.models.high.provider as string
            const providers = cfg.providers as Record<string, any>
            const cur = providers[curProvider] || {}

            scr.addLine(chalk.bold('  ── API 配置 ──'))
            scr.addLine(chalk.dim(`  当前: ${curProvider} | ${cur.baseUrl || '(默认)'} | ${config.models.high.id} / ${config.models.low.id}`))
            scr.addLine('')
            scr.addLine(chalk.bold('  选择模型商 (输入数字) 或直接输入自定义 Base URL:'))
            scr.addLine(chalk.dim('  1. DeepSeek    https://api.deepseek.com'))
            scr.addLine(chalk.dim('  2. OpenAI      https://api.openai.com/v1'))
            scr.addLine(chalk.dim('  3. Claude      https://api.anthropic.com/v1'))
            scr.addLine(chalk.dim('  4. 硅基流动    https://api.siliconflow.cn/v1'))
            scr.addLine(chalk.dim('  5. Ollama本地  http://localhost:11434/v1'))
            scr.addLine('')

            const choice = await askField('Base URL', '输入 1-5 选择预设，或粘贴自定义 URL')

            let baseUrl: string
            let presetModels: string[] = []
            let providerName = curProvider

            if (PRESETS[choice]) {
              baseUrl = PRESETS[choice].url
              presetModels = PRESETS[choice].models
              providerName = choice === '1' ? 'deepseek' : choice === '2' ? 'openai' : choice === '3' ? 'claude' : 'openai'
              scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + chalk.green(baseUrl) + chalk.dim(' ✓')
            } else if (choice) {
              let url = choice.replace(/[<>]/g, '').replace(/\/+$/, '')
              if (!url.startsWith('http')) url = 'https://' + url
              baseUrl = url
              providerName = 'openai' // OpenAI-compatible
              scr.lines[scr.lines.length - 1] = chalk.dim('  > ') + chalk.green(baseUrl) + chalk.dim(' ✓')
            } else {
              baseUrl = cur.baseUrl || 'https://api.deepseek.com'
              scr.lines[scr.lines.length - 1] = chalk.dim('  > (跳过)')
            }
            scr.render()

            // API Key
            const curKey = cur.apiKey || ''
            const keyHint = curKey ? `当前: ${curKey.slice(0, 8)}...${curKey.slice(-4)}` : '(未设置)'
            const apiKey = await askField('API Key', keyHint)
            scr.lines[scr.lines.length - 1] = apiKey
              ? chalk.dim('  > ') + chalk.green(apiKey.slice(0, 8) + '...') + chalk.dim(' ✓')
              : chalk.dim('  > (跳过)')
            scr.render()

            // High model
            const highHint = presetModels.length
              ? `推荐: ${presetModels.slice(0, 2).join(' / ')}  当前: ${cfg.models.high.id}`
              : `当前: ${cfg.models.high.id}`
            const highModel = await askField('高性能模型 (规划用)', highHint)
            scr.lines[scr.lines.length - 1] = highModel
              ? chalk.dim('  > ') + chalk.green(highModel) + chalk.dim(' ✓')
              : chalk.dim('  > (跳过)')
            scr.render()

            // Low model
            const lowHint = presetModels.length
              ? `推荐: ${presetModels.slice(2).join(' / ')}  当前: ${cfg.models.low.id}`
              : `当前: ${cfg.models.low.id}`
            const lowModel = await askField('低性能模型 (执行用)', lowHint)
            scr.lines[scr.lines.length - 1] = lowModel
              ? chalk.dim('  > ') + chalk.green(lowModel) + chalk.dim(' ✓')
              : chalk.dim('  > (跳过)')
            scr.render()

            // Max tokens
            const presetMax = choice === '1' ? '393216' : choice === '3' ? '1000000' : '128000'
            const maxHint = `当前: ${cfg.maxTokens || 128000}  预设推荐: ${presetMax}`
            const maxTokensStr = await askField('maxTokens (单次回复上限)', maxHint)
            const maxTokens = maxTokensStr ? parseInt(maxTokensStr, 10) : 0
            scr.lines[scr.lines.length - 1] = maxTokens
              ? chalk.dim('  > ') + chalk.green(String(maxTokens)) + chalk.dim(' ✓')
              : chalk.dim('  > (跳过)')
            scr.render()

            // Apply changes
            let changed = false
            try {
              if (!providers[providerName]) providers[providerName] = {}
              if (baseUrl) { providers[providerName].baseUrl = baseUrl; changed = true }
              if (apiKey) { providers[providerName].apiKey = apiKey; changed = true }
              if (highModel) { cfg.models.high.id = highModel; cfg.models.high.provider = providerName as any; changed = true }
              if (lowModel) { cfg.models.low.id = lowModel; cfg.models.low.provider = providerName as any; changed = true }
              if (maxTokens) { cfg.maxTokens = maxTokens; changed = true }

              if (changed) {
                await saveConfig(cfg)
                Object.assign(config, cfg)
                adapters = createAdapters(config, adapters)
                scr.addLine('')
                scr.addLine(chalk.green('  ✓ 配置已保存并生效'))
                scr.addLine(chalk.dim(`  ${providerName} | ${baseUrl} | ${cfg.models.high.id} / ${cfg.models.low.id}`))
              } else {
                scr.addLine('')
                scr.addLine(chalk.dim('  未修改'))
              }
            } catch (e: any) {
              scr.addLine(chalk.red(`  ✗ 保存失败: ${e.message}`))
            }
            scr.addLine('')
            scr.render()
            return
          }

          case 'cc': {
            scr.addLine(chalk.dim('  启动 cc-connect...'))
            scr.addLine(chalk.dim('  （退出 cc-connect 后将返回 neo-cli）'))
            scr.render()

            // Exit alternate screen, run cc-connect, then re-enter
            mainScreen()
            process.stdin.setRawMode(false)

            await new Promise<void>((resolve) => {
              const child = spawn('cc-connect', [], {
                stdio: 'inherit',
                shell: true,
              })
              child.on('close', () => resolve())
              child.on('error', (err) => {
                console.error('cc-connect 启动失败:', err.message)
                console.error('请先安装: npm install -g cc-connect')
                resolve()
              })
            })

            // Re-enter alternate screen
            altScreen()
            write('\x1b[2J\x1b[H')
            process.stdin.setRawMode(true)
            scr.render()
            return
          }

          case 'exit':
          case 'quit':
            scr.exit()
            process.exit(0)
          default:
            scr.addLine(chalk.yellow(`  未知命令: /${cmd}，输入 /help 查看帮助`))
            scr.addLine('')
            scr.render()
            return
        }
      }

      locked = true
      await processInput(input)
      locked = false
      return
    }

    // Backspace
    if (code === 0x7f || code === 0x08) {
      if (scr.input.length > 0) {
        const pos = scr.input.length - scr.cursor
        if (pos > 0) {
          scr.input = scr.input.slice(0, pos - 1) + scr.input.slice(pos)
        }
        scr.render()
      }
      return
    }

    // Ctrl+C
    if (code === 0x03) { scr.exit(); process.exit(0) }

    // Ctrl+U
    if (code === 0x15) { scr.input = ''; scr.cursor = 0; scr.render(); return }

    // Char - insert at cursor position
    if (code >= 0x20) {
      const pos = scr.input.length - scr.cursor
      scr.input = scr.input.slice(0, pos) + key + scr.input.slice(pos)
      scr.updateCommands()
      scr.render()
    }
  })

  process.stdout.on('resize', () => scr.render())
  process.on('SIGINT', () => { scr.exit(); process.exit(0) })
}

// ── Run 模式 ─────────────────────────────────────────────────
async function runMode(config: AppConfig, task: string): Promise<void> {
  const adapters = createAdapters(config)
  const { registry, defs } = createDefaultToolRegistry()
  const session = new SessionManager()
  await session.init()
  const { id } = session.createSession()
  const logPath = session.getLogPath(id)

  const loop = new CacheFirstLoop({
    adapters, config, tools: defs, toolRegistry: registry, sessionPath: logPath,
  })

  for await (const event of loop.step(task)) {
    if (event.type === 'text') process.stdout.write(event.content)
  }
  await loop.saveSession()
  process.stdout.write('\n')
}

// ── CLI ──────────────────────────────────────────────────────
const program = new Command()
program.name('neo').description('Cache-first coding agent').version(VERSION)

program.command('init').description('初始化配置').action(async () => {
  await initConfig()
  console.log('配置已创建: ~/.neo-cli/config.json')
})

program.command('code').description('交互式编码模式').argument('[prompt]').action(async (p?: string) => {
  await interactiveMode(await loadConfig(), p)
})

program.command('run').description('一次性执行').argument('<task>').action(async (t: string) => {
  await runMode(await loadConfig(), t)
})

program.argument('[prompt]').action(async (p?: string) => {
  await interactiveMode(await loadConfig(), p)
})

program.parse()
