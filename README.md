# Raymes

![Raymes Screenshot](screenshot.png)

Raymes is a high-performance, lightweight spotlight alternative for macOS, blending the best of **Raycast** with the power of the **PI agent**. 

Originally conceived with Hermes in mind, the project shifted to **PI agent** for its incredible lightweight footprint and efficiency.

## 🚀 Key Features

### 🧮 Smart Tools
- **Calculator**: Built-in math engine (via `mathjs`) for complex expressions.
- **Currency Conversion**: Real-time conversion (e.g., `USD => EUR`, `100 yuan to dollar`) powered by the Frankfurter API.

### 🖥️ Native macOS Control
Integrated support for system-level commands, inspired by [mac-cli](https://github.com/guarinogabriel/mac-cli).
- **System**: Lock screen, Empty trash, Toggle Dark Mode.
- **Connectivity**: Toggle Bluetooth, Toggle Wi-Fi, Show Network Info.
- **Navigation**: Open Downloads, Applications, or reveal hidden Library folders.
- **Hardware**: Start Screen Saver, Sleep Display, Sleep Mac.
- **Media**: Toggle Mute, Volume Up/Down.
- **Developer**: List Listening Ports, Git Root path, Homebrew updates, Memory/CPU/Disk info.

### 🧩 Extension Support
Raymes implements roughly half of the **Raycast** extension API, allowing for a rich ecosystem of tools. The implementation draws inspiration from the [SuperCmd](https://github.com/SuperCmdLabs/SuperCmd) project to provide a robust runtime for Raycast-style extensions.

### 🤖 The Agent (The Best Part)
Raymes features an **Agent** built directly into the spotlight interface. 

![Raymes Agent](agent-screenshot.png)

- **Coding Assistant**: Powered by PI agent, capable of reading files, executing bash commands, and editing code directly from your search bar.
- **Audio Input**: Support for voice commands using state-of-the-art local models:
  - **Whisper (via whisper.cpp)**: Fast, high-accuracy transcription.
  - **Moonshine/Parakeet**: Ultra-low latency voice-to-text models.
  - No cloud dependency for transcription; everything stays on your machine.

### 📋 Productivity Suite
- **Clipboard History**: Browse and search through your past copies.
- **Snippets**: Quick access to your text templates and boilerplate.
- **Quick Notes**: A lightweight notepad for jotting down ideas.
- **Emoji Picker**: Search and copy emojis instantly.

## 🛠️ Architecture
- **Framework**: Electron + Vite + React
- **Language**: TypeScript / Rust (for native input handling) / Swift (for accessibility helpers)
- **Agent**: PI agent integration
- **Styling**: Tailwind CSS

## 🏗️ Development

### Prerequisites
- [pnpm](https://pnpm.io/)
- macOS (for native system commands)
- [Homebrew](https://brew.sh/) (for `whisper-cpp`, `ffmpeg`, etc.)

### Setup
```bash
pnpm install
pnpm build:native  # Compiles Rust and Swift helpers
pnpm dev           # Starts the Electron app
```

## ⚖️ Credits
- **PI Agent**: For the lightweight agentic core.
- **Raycast**: For the UI inspiration and extension API.
- **SuperCmd**: For patterns in implementing Raycast shims.
- **mac-cli**: For the inspiration behind native macOS commands.
