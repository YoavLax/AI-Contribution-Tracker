# Migration Removal Checklist

## ✅ Migration Complete

The platform components have been successfully migrated to:
**https://github.com/Varonis-Systems/AI-Contribution-Tracker-Platform**

**Commits:**
- `f4c1d64` - Initial commit with platform components (dashboard, sync service, docs, tasks, scripts/local-setup.ps1)
- `439af2c` - Additional platform components (.github/skills, .github/workflows, scripts/ralph, RnD_Engineering_Users_Hierarchy.csv)
- `03fe3d4` - Add progress.txt tracking platform development history

---

## 📋 Files and Folders to Remove from AI-Contribution-Tracker

### Directories to Remove

#### 1. **agentic-dashboard/**
   - **Description**: Next.js 15 dashboard application
   - **Size**: ~89 files, ~1.05 MB
   - **Contents**:
     - Dashboard UI components
     - API routes for statistics
     - Prisma schema
     - Test files
     - All subdirectories (app/, components/, hooks/, lib/, etc.)
   - **Command**: `Remove-Item -Recurse -Force .\agentic-dashboard`

#### 2. **github-sync-service/**
   - **Description**: Node.js backend sync service
   - **Size**: ~52 files, ~755 KB
   - **Contents**:
     - Express API server
     - GitHub client implementations
     - Sync orchestrator
     - Prisma schema and migrations
     - Kubernetes deployment manifests
     - Test files
   - **Command**: `Remove-Item -Recurse -Force .\github-sync-service`

#### 3. **docs/**
   - **Description**: Platform architecture documentation
   - **Size**: 5 files, ~489 KB
   - **Files**:
     - `1-ai-detection-and-commit-tagging-flow.jpg`
     - `1-ai-detection-and-commit-tagging-flow.puml`
     - `GITHUB_SYNC_SERVICE_DESIGN.md`
     - `GITHUB_SYNC_SERVICE_TASKS.md`
     - `GITHUB_THROTTLING_OPTIMIZATION_PLAN.md`
   - **Command**: `Remove-Item -Recurse -Force .\docs`

#### 4. **tasks/**
   - **Description**: Product requirements and planning documents
   - **Size**: 4 files, ~58 KB
   - **Files**:
     - `PRD-GitHub API Throttling Optimization.md`
     - `PRD-GitHub Sync Service.md`
     - `PRD.md`
     - `prd.json`
   - **Command**: `Remove-Item -Recurse -Force .\tasks`

#### 5. **scripts/**
   - **Description**: All platform scripts including setup and Ralph automation
   - **Size**: 5 files, ~18 KB
   - **Contents**:
     - `local-setup.ps1` - Platform setup script
     - `ralph/` - Ralph autonomous agent automation
       - `CLAUDE.md` - Claude context
       - `progress.txt` - Progress tracking
       - `prompt.md` - Prompt template
       - `ralph.sh` - Automation script
   - **Command**: `Remove-Item -Recurse -Force .\scripts`

#### 6. **.github/skills/**
   - **Description**: Copilot skills for development best practices
   - **Size**: 57 files, ~171 KB
   - **Contents**:
     - `prd/` - PRD generation skill for Ralph
     - `ralph/` - Ralph JSON format skill
     - `vercel-react-best-practices/` - React/Next.js optimization rules (51 files)
     - `web-design-guidelines/` - UI best practices
     - `SKILL-OLD-RALPH-PRD-FORMAT.md` - Legacy skill
   - **Command**: `Remove-Item -Recurse -Force .\.github\skills`

#### 7. **.github/workflows/**
   - **Description**: GitHub Actions workflows
   - **Size**: 1 file, ~1 KB
   - **Contents**:
     - `prisma-migrate.yml` - Database migration workflow
   - **Command**: `Remove-Item -Recurse -Force .\.github\workflows`

#### 8. **RnD_Engineering_Users_Hierarchy.csv**
   - **Description**: User hierarchy data for organization structure
   - **Size**: 1 file, ~7 KB
   - **Note**: Contains manager-employee relationships for the sync service
   - **Command**: `Remove-Item .\RnD_Engineering_Users_Hierarchy.csv`

#### 9. **progress.txt**
   - **Description**: Platform development progress log
   - **Size**: 1 file, ~12 KB
   - **Note**: Contains detailed commit logs and user story completion history
   - **Command**: `Remove-Item .\progress.txt`

---

## 🔒 Files and Folders to KEEP in AI-Contribution-Tracker

These components are specific to the VS Code extension and should remain:

### Extension Core
- ✅ **src/** - Extension source code
  - `extension.ts` - Extension entry point
  - `tracker.ts` - AI detection logic
  - `test/` - Extension tests

### Extension UI
- ✅ **webview-ui/** - Extension webview components (if used)

### Extension Configuration
- ✅ **package.json** - Extension manifest and dependencies
- ✅ **tsconfig.json** - TypeScript configuration
- ✅ **esbuild.js** - Extension bundler configuration
- ✅ **eslint.config.mjs** - Linting configuration
- ✅ **.vscode/** - VS Code workspace settings
- ✅ **.vscodeignore** - Extension publishing ignore file

### Documentation
- ✅ **README.md** - Extension documentation (needs update)
- ✅ **CHANGELOG.md** - Extension changelog
- ✅ **LICENSE** - License file
- ✅ **AGENTIC_DETECTION_PLAN.md** - Extension detection plan

### GitHub Configuration
- ✅ **.github/copilot-instructions.md** - Copilot instructions (needs update)
- ✅ **.gitignore** - Git ignore rules

### Other Files
- ✅ **.git/** - Git repository data

---

## 📝 Post-Removal Actions Required

After removing the platform components, you should:

### 1. Update README.md
   - Remove references to agentic-dashboard and github-sync-service
   - Add link to the new platform repository
   - Focus documentation on VS Code extension features
   - Update architecture diagram to show separation

### 2. Update package.json
   - Ensure only extension-related scripts remain
   - Verify dependencies are extension-specific only
   - Update repository URLs if needed

### 3. Update .gitignore
   - Remove platform-specific ignore patterns (if any)
   - Keep extension-specific patterns

### 4. Update .github/copilot-instructions.md
   - Remove references to agentic-dashboard and github-sync-service architecture
   - Keep only extension-related instructions
   - Add reference to the platform repository for context

### 5. Clean up .github/ directory
   - Verify no platform-specific workflows remain (they've been moved)
   - Keep only extension-related GitHub configuration

---

## 🚀 Removal Commands

Execute these PowerShell commands from the repository root after approval:

```powershell
# Navigate to repository root
cd c:\Users\dexterman\source\repos\AI-Contribution-Tracker\AI-Contribution-Tracker

# Remove platform directories
Remove-Item -Recurse -Force .\agentic-dashboard
Remove-Item -Recurse -Force .\github-sync-service
Remove-Item -Recurse -Force .\docs
Remove-Item -Recurse -Force .\tasks
Remove-Item -Recurse -Force .\scripts
Remove-Item -Recurse -Force .\.github\skills
Remove-Item -Recurse -Force .\.github\workflows

# Remove platform file
Remove-Item -Force .\RnD_Engineering_Users_Hierarchy.csv
Remove-Item -Force .\progress.txt

# Verify removal
Write-Host "`n✅ Removed directories and files:"
Write-Host "   - agentic-dashboard/"
Write-Host "   - github-sync-service/"
Write-Host "   - docs/"
Write-Host "   - tasks/"
Write-Host "   - scripts/"
Write-Host "   - .github/skills/"
Write-Host "   - .github/workflows/"
Write-Host "   - RnD_Engineering_Users_Hierarchy.csv"
Write-Host "   - progress.txt"
Write-Host "`n⚠️  Next steps:"
Write-Host "   1. Update README.md"
Write-Host "   2. Update .github/copilot-instructions.md"
Write-Host "   3. Commit changes with: git commit -m 'Migrate platform components to separate repository'"
Write-Host "   4. Push changes"
```

---

## ⚠️ Important Notes

1. **Backup**: The migrated code is safely stored in the new repository at:
   https://github.com/Varonis-Systems/AI-Contribution-Tracker-Platform

2. **Git History**: The full history of these files remains in the AI-Contribution-Tracker repository's git history. They can be recovered if needed.

3. **Dependencies**: After removal, verify the extension still builds and runs correctly:
   ```bash
   npm install
   npm run compile
   npm run test
   ```

4. **Cross-Repository References**: Update any documentation or code that references the platform components to point to the new repository.

---

## 🔍 Verification Checklist

Before considering the migration complete, verify:

- [ ] Platform repository is accessible and working
- [ ] All files were copied correctly to the new repository
- [ ] New repository has appropriate README and documentation
- [ ] New repository has .gitignore configured
- [ ] Initial commit is pushed to main branch
- [ ] Extension still functions after removing platform code
- [ ] Extension tests still pass
- [ ] Documentation is updated in both repositories
- [ ] Team members are informed of the split

---

**Status**: ⏸️ **AWAITING USER APPROVAL FOR REMOVAL**

Please review this checklist and confirm before proceeding with file removal.
