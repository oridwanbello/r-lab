# R Quadrant Setup & Scaffolding Guide

This guide documents the initial setup and configuration of the **R Quadrant** VS Code extension.

## 1. Environment Preparation

Before initializing the project, ensure you are in the target parent directory and have the necessary generators installed.

```bash
cd remote

# Install the VS Code Extension generator via Yeoman
npm install -g yo generator-code
```

## 2. Project Initialization

The project was scaffolded using `yo code` with the following configuration:

| Setting | Selection |
| :--- | :--- |
| **Type** | New Extension (TypeScript) |
| **Name** | R Quadrant |
| **Identifier** | `r-quadrant` |
| **Description** | An RStudio-style 4-pane layout orchestrator for data scientists. |
| **Git** | Yes |
| **Webpack** | Yes |
| **Package Manager** | npm |

```bash
yo code
```

## 3. Repository Configuration

After scaffolding, the local repository was initialized and linked to GitHub.

> [!IMPORTANT]
> The `git add` and `git commit` steps are required before the initial push to create the `main` branch locally.

```bash
# Enter the project directory
cd R-Quadrant

# Initialize branch and remote
git branch -M main
git remote add origin https://github.com/oridwanbello/R-Quadrant.git

# Stage and commit files
git add .
git commit -m "Initial scaffold"

# Push to GitHub
git push -u origin main
```

## 4. Project Structure

The source code follows a modular architecture:

```
R-Quadrant/
├── src/
│   ├── extension.ts                  # Entry point — wires everything together
│   ├── layout/
│   │   └── layoutManager.ts          # Layout toggle command & Status Bar button
│   ├── views/
│   │   ├── environmentExplorer.ts    # TreeDataProvider for debug variables
│   │   ├── plotGallery.ts            # WebviewViewProvider for plot gallery
│   │   └── dataViewer.ts             # WebviewViewProvider for dataframe inspection
│   ├── util/
│   │   └── debugSession.ts           # DAP helper utilities
│   └── test/
│       └── extension.test.ts         # Test suite
├── resources/
│   └── quadrant-icon.svg             # Activity Bar icon
├── docs/
│   ├── executive_blueprint.md        # PRD & Roadmap
│   ├── setup.md                      # This file
│   └── architecture.md               # Technical architecture reference
├── package.json                      # Extension manifest
├── tsconfig.json                     # TypeScript configuration
└── webpack.config.js                 # Build configuration
```

## 5. Development Workflow

### File Modifications
As the project progresses, you will frequently modify these core files to implement features like the TreeView and Webviews:
* `package.json`: For registering commands, views, and configurations.
* `src/extension.ts`: For wiring up new providers and commands.
* `src/views/`: For implementing view providers (TreeView and Webview).
* `src/util/`: For shared utilities (DAP helpers, etc.).
* `resources/`: For icons and static assets.

### Running & Debugging
1. Ensure the webpack watcher is running (to auto-compile changes):
   ```bash
   npm run watch
   ```
2. Press `Fn + F5` (or `F5`) to launch a new **Extension Development Host** window.
3. In the new window, use the command palette or status bar button to test the **R Quadrant Layout**.
4. The R Quadrant sidebar should appear in the Activity Bar with three panels: Environment, Plots, and Data Viewer.
