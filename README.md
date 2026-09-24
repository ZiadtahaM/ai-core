# AI Core

Core inference and prompting library for autonomous agents.

![AI Core Modules](https://via.placeholder.com/1200x600.png?text=AI+Core+Modules)

## Overview
AI Core acts as the foundational shared library across various AI agent repositories. It centralizes strict typing, message formatting, and LLM communication logic to prevent code duplication.

## Tech Stack
- **Language**: TypeScript
- **Runtime**: Node.js

## Architecture
This project is structured as an NPM package or internal monorepo dependency. The `src/` directory contains pure, side-effect-free utility functions that manage prompt serialization, chunking, and memory formatting to enforce the standard OpenAI/Anthropic message shapes.

## Local Setup
1. Clone the repository.
2. Run `npm install`.
3. Build the TypeScript source with `npm run build` or `npx tsc`.
