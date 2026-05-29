# NEO-CLI

[![npm](https://img.shields.io/npm/v/neo-cli-agent)](https://www.npmjs.com/package/neo-cli-agent)
[![license](https://img.shields.io/npm/l/neo-cli-agent)](./LICENSE)

多 API 缓存优先的智能编码代理，支持自动模型切换。

## 功能特性

- **缓存优先架构** — 跨 Claude、OpenAI、DeepSeek 的稳定前缀缓存
- **自动模型切换** — 规划用高性能模型，执行用低性能模型，自动判断
- **MIMO 深度思考协议** — 自适应思考深度（简单/中等/复杂问题自动识别）
- **全屏 TUI 界面** — 终端富交互：鼠标滚轮、文本选择、命令面板、剪贴板
- **工具系统** — 文件读写编辑、Shell 命令执行、grep 搜索、glob 文件查找
- **会话持久化** — JSONL 格式存储会话历史，支持恢复历史会话
- **MBTI 性格系统** — 根据你的性格类型调整 AI 沟通风格

## 快速开始

### 一键安装（推荐）

```bash
npm install -g neo-cli-agent
neo-agent
```

### 从源码安装

```bash
git clone https://github.com/chuwentian300-sketch/Neo-Cli--cli.git
cd Neo-Cli--cli
npm install
npm run build
npm link
neo-agent
```

## 配置说明

配置文件路径：`~/.neo-cli/config.json`

```json
{
  "providers": {
    "deepseek": { "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com" },
    "openai": { "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1" },
    "claude": { "apiKey": "sk-...", "baseUrl": "https://api.anthropic.com/v1" }
  },
  "models": {
    "high": { "provider": "deepseek", "id": "deepseek-v4-pro" },
    "low": { "provider": "deepseek", "id": "deepseek-v4-flash" }
  }
}
```

初始化配置：

```bash
neo-agent init
```

支持通过 `/api` 命令在界面内交互式配置，支持预设模型商：
- DeepSeek
- OpenAI
- Claude
- 硅基流动
- Ollama 本地模型

## 命令列表

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/api` | 配置 API（地址/Key/模型） |
| `/mbti` | 设置性格类型（影响对话风格） |
| `/thinking` | 设置思考动画效果（10 种可选） |
| `/copy` | 复制最后一条 AI 回复到剪贴板 |
| `/model` | 显示当前使用的模型 |
| `/mode` | 切换自动/手动模式 |
| `/clear` | 清空输出 |
| `/session` | 显示会话信息（消息数、轮次、花费） |
| `/resume` | 恢复历史会话 |
| `/compact` | 强制压缩上下文 |
| `/cc` | 打开 cc-connect 消息桥 |
| `/exit` | 退出 |

## 快捷键

| 按键 | 功能 |
|------|------|
| `ESC` | 中断任务 / 清空输入 |
| `Tab` | 切换自动/手动模式 |
| `↑↓` | 浏览历史记录 / 命令面板选择 |
| `←→` | 移动光标 |
| `PgUp/PgDn` | 滚动输出内容 |
| `Ctrl+U` | 清空输入框 |
| `Shift+点击` | 选择文本 |
| `鼠标滚轮` | 滚动输出 |

## 项目结构

```
src/
├── adapters/     # API 适配器（Claude、OpenAI、DeepSeek）
├── cli/          # 全屏 TUI 终端界面
├── config/       # 配置加载与校验（zod）
├── core/         # 核心循环：CacheFirstLoop、上下文管理、模型切换
├── memory/       # 持久化记忆系统
├── prompts/      # 系统提示词、MIMO 思考协议、动画效果
├── session/      # JSONL 会话持久化
└── tools/        # 工具：文件操作、Shell 执行、搜索
```

## 技术栈

- **TypeScript** + **Node.js 20+**
- **tsup** 构建
- **zod** 配置校验
- **commander** CLI 框架
- **undici** HTTP 客户端

## 开源协议

MIT
