/**
 * Auto Mode Service - Autonomous feature implementation using Claude Agent SDK
 *
 * Manages:
 * - Worktree creation for isolated development
 * - Feature execution with Claude
 * - Concurrent execution with max concurrency limits
 * - Progress streaming via events
 * - Verification and merge workflows
 */

import { ProviderFactory } from "../providers/provider-factory.js";
import type { ExecuteOptions } from "../providers/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import type { EventEmitter } from "../lib/events.js";
import { buildPromptWithImages } from "../lib/prompt-builder.js";
import { resolveModelString, DEFAULT_MODELS } from "../lib/model-resolver.js";
import { createAutoModeOptions } from "../lib/sdk-options.js";
import { isAbortError, classifyError } from "../lib/error-handler.js";

const execAsync = promisify(exec);

type PlanningMode = 'skip' | 'lite' | 'spec' | 'full';

interface ParsedTask {
  id: string;          // e.g., "T001"
  description: string; // e.g., "Create user model"
  filePath?: string;   // e.g., "src/models/user.ts"
  phase?: string;      // e.g., "Phase 1: Foundation" (for full mode)
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

interface PlanSpec {
  status: 'pending' | 'generating' | 'generated' | 'approved' | 'rejected';
  content?: string;
  version: number;
  generatedAt?: string;
  approvedAt?: string;
  reviewedByUser: boolean;
  tasksCompleted?: number;
  tasksTotal?: number;
  currentTaskId?: string;
  tasks?: ParsedTask[];
}

const PLANNING_PROMPTS = {
  lite: `## Planning Phase (Lite Mode)

Before implementing, create a brief planning outline:

1. **Goal**: What are we accomplishing? (1 sentence)
2. **Approach**: How will we do it? (2-3 sentences)
3. **Files to Touch**: List files and what changes
4. **Tasks**: Numbered task list (3-7 items)
5. **Risks**: Any gotchas to watch for

After generating the outline, output:
"[PLAN_GENERATED] Planning outline complete."

Then proceed with implementation.`,

  lite_with_approval: `## Planning Phase (Lite Mode)

Before implementing, create a brief planning outline:

1. **Goal**: What are we accomplishing? (1 sentence)
2. **Approach**: How will we do it? (2-3 sentences)
3. **Files to Touch**: List files and what changes
4. **Tasks**: Numbered task list (3-7 items)
5. **Risks**: Any gotchas to watch for

After generating the outline, output:
"[SPEC_GENERATED] Please review the planning outline above. Reply with 'approved' to proceed or provide feedback for revisions."

DO NOT proceed with implementation until you receive explicit approval.`,

  spec: `## Specification Phase (Spec Mode)

Before implementing, generate a specification with an actionable task breakdown. WAIT for approval before implementing.

### Specification Format

1. **Problem**: What problem are we solving? (user perspective)

2. **Solution**: Brief approach (1-2 sentences)

3. **Acceptance Criteria**: 3-5 items in GIVEN-WHEN-THEN format
   - GIVEN [context], WHEN [action], THEN [outcome]

4. **Files to Modify**:
   | File | Purpose | Action |
   |------|---------|--------|
   | path/to/file | description | create/modify/delete |

5. **Implementation Tasks**:
   Use this EXACT format for each task (the system will parse these):
   \`\`\`tasks
   - [ ] T001: [Description] | File: [path/to/file]
   - [ ] T002: [Description] | File: [path/to/file]
   - [ ] T003: [Description] | File: [path/to/file]
   \`\`\`

   Task ID rules:
   - Sequential: T001, T002, T003, etc.
   - Description: Clear action (e.g., "Create user model", "Add API endpoint")
   - File: Primary file affected (helps with context)
   - Order by dependencies (foundational tasks first)

6. **Verification**: How to confirm feature works

After generating the spec, output on its own line:
"[SPEC_GENERATED] Please review the specification above. Reply with 'approved' to proceed or provide feedback for revisions."

DO NOT proceed with implementation until you receive explicit approval.

When approved, execute tasks SEQUENTIALLY in order. For each task:
1. BEFORE starting, output: "[TASK_START] T###: Description"
2. Implement the task
3. AFTER completing, output: "[TASK_COMPLETE] T###: Brief summary"

This allows real-time progress tracking during implementation.`,

  full: `## Full Specification Phase (Full SDD Mode)

Before implementing, generate a comprehensive specification with phased task breakdown. WAIT for approval before implementing.

### Specification Format

1. **Problem Statement**: 2-3 sentences from user perspective

2. **User Story**: As a [user], I want [goal], so that [benefit]

3. **Acceptance Criteria**: Multiple scenarios with GIVEN-WHEN-THEN
   - **Happy Path**: GIVEN [context], WHEN [action], THEN [expected outcome]
   - **Edge Cases**: GIVEN [edge condition], WHEN [action], THEN [handling]
   - **Error Handling**: GIVEN [error condition], WHEN [action], THEN [error response]

4. **Technical Context**:
   | Aspect | Value |
   |--------|-------|
   | Affected Files | list of files |
   | Dependencies | external libs if any |
   | Constraints | technical limitations |
   | Patterns to Follow | existing patterns in codebase |

5. **Non-Goals**: What this feature explicitly does NOT include

6. **Implementation Tasks**:
   Use this EXACT format for each task (the system will parse these):
   \`\`\`tasks
   ## Phase 1: Foundation
   - [ ] T001: [Description] | File: [path/to/file]
   - [ ] T002: [Description] | File: [path/to/file]

   ## Phase 2: Core Implementation
   - [ ] T003: [Description] | File: [path/to/file]
   - [ ] T004: [Description] | File: [path/to/file]

   ## Phase 3: Integration & Testing
   - [ ] T005: [Description] | File: [path/to/file]
   - [ ] T006: [Description] | File: [path/to/file]
   \`\`\`

   Task ID rules:
   - Sequential across all phases: T001, T002, T003, etc.
   - Description: Clear action verb + target
   - File: Primary file affected
   - Order by dependencies within each phase
   - Phase structure helps organize complex work

7. **Success Metrics**: How we know it's done (measurable criteria)

8. **Risks & Mitigations**:
   | Risk | Mitigation |
   |------|------------|
   | description | approach |

After generating the spec, output on its own line:
"[SPEC_GENERATED] Please review the comprehensive specification above. Reply with 'approved' to proceed or provide feedback for revisions."

DO NOT proceed with implementation until you receive explicit approval.

When approved, execute tasks SEQUENTIALLY by phase. For each task:
1. BEFORE starting, output: "[TASK_START] T###: Description"
2. Implement the task
3. AFTER completing, output: "[TASK_COMPLETE] T###: Brief summary"

After completing all tasks in a phase, output:
"[PHASE_COMPLETE] Phase N complete"

This allows real-time progress tracking during implementation.`
};

/**
 * Parse tasks from generated spec content
 * Looks for the ```tasks code block and extracts task lines
 * Format: - [ ] T###: Description | File: path/to/file
 */
function parseTasksFromSpec(specContent: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  // Extract content within ```tasks ... ``` block
  const tasksBlockMatch = specContent.match(/```tasks\s*([\s\S]*?)```/);
  if (!tasksBlockMatch) {
    // Try fallback: look for task lines anywhere in content
    const taskLines = specContent.match(/- \[ \] T\d{3}:.*$/gm);
    if (!taskLines) {
      return tasks;
    }
    // Parse fallback task lines
    let currentPhase: string | undefined;
    for (const line of taskLines) {
      const parsed = parseTaskLine(line, currentPhase);
      if (parsed) {
        tasks.push(parsed);
      }
    }
    return tasks;
  }

  const tasksContent = tasksBlockMatch[1];
  const lines = tasksContent.split('\n');

  let currentPhase: string | undefined;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check for phase header (e.g., "## Phase 1: Foundation")
    const phaseMatch = trimmedLine.match(/^##\s*(.+)$/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim();
      continue;
    }

    // Check for task line
    if (trimmedLine.startsWith('- [ ]')) {
      const parsed = parseTaskLine(trimmedLine, currentPhase);
      if (parsed) {
        tasks.push(parsed);
      }
    }
  }

  return tasks;
}

/**
 * Parse a single task line
 * Format: - [ ] T###: Description | File: path/to/file
 */
function parseTaskLine(line: string, currentPhase?: string): ParsedTask | null {
  // Match pattern: - [ ] T###: Description | File: path
  const taskMatch = line.match(/- \[ \] (T\d{3}):\s*([^|]+)(?:\|\s*File:\s*(.+))?$/);
  if (!taskMatch) {
    // Try simpler pattern without file
    const simpleMatch = line.match(/- \[ \] (T\d{3}):\s*(.+)$/);
    if (simpleMatch) {
      return {
        id: simpleMatch[1],
        description: simpleMatch[2].trim(),
        phase: currentPhase,
        status: 'pending',
      };
    }
    return null;
  }

  return {
    id: taskMatch[1],
    description: taskMatch[2].trim(),
    filePath: taskMatch[3]?.trim(),
    phase: currentPhase,
    status: 'pending',
  };
}

interface Feature {
  id: string;
  category: string;
  description: string;
  steps?: string[];
  status: string;
  priority?: number;
  spec?: string;
  model?: string; // Model to use for this feature
  imagePaths?: Array<
    | string
    | {
        path: string;
        filename?: string;
        mimeType?: string;
        [key: string]: unknown;
      }
  >;
  planningMode?: PlanningMode;
  planSpec?: PlanSpec;
  requirePlanApproval?: boolean; // If true, pause for user approval before implementation
}

interface RunningFeature {
  featureId: string;
  projectPath: string;
  worktreePath: string | null;
  branchName: string | null;
  abortController: AbortController;
  isAutoMode: boolean;
  startTime: number;
}

interface AutoModeConfig {
  maxConcurrency: number;
  useWorktrees: boolean;
  projectPath: string;
}

interface PendingApproval {
  resolve: (result: { approved: boolean; editedPlan?: string; feedback?: string }) => void;
  reject: (error: Error) => void;
  featureId: string;
  projectPath: string;
}

export class AutoModeService {
  private events: EventEmitter;
  private runningFeatures = new Map<string, RunningFeature>();
  private autoLoopRunning = false;
  private autoLoopAbortController: AbortController | null = null;
  private config: AutoModeConfig | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(events: EventEmitter) {
    this.events = events;
  }

  /**
   * Start the auto mode loop - continuously picks and executes pending features
   */
  async startAutoLoop(projectPath: string, maxConcurrency = 3): Promise<void> {
    if (this.autoLoopRunning) {
      throw new Error("Auto mode is already running");
    }

    this.autoLoopRunning = true;
    this.autoLoopAbortController = new AbortController();
    this.config = {
      maxConcurrency,
      useWorktrees: true,
      projectPath,
    };

    this.emitAutoModeEvent("auto_mode_started", {
      message: `Auto mode started with max ${maxConcurrency} concurrent features`,
      projectPath,
    });

    // Run the loop in the background
    this.runAutoLoop().catch((error) => {
      console.error("[AutoMode] Loop error:", error);
      this.emitAutoModeEvent("auto_mode_error", {
        error: error.message,
      });
    });
  }

  private async runAutoLoop(): Promise<void> {
    while (
      this.autoLoopRunning &&
      this.autoLoopAbortController &&
      !this.autoLoopAbortController.signal.aborted
    ) {
      try {
        // Check if we have capacity
        if (this.runningFeatures.size >= (this.config?.maxConcurrency || 3)) {
          await this.sleep(5000);
          continue;
        }

        // Load pending features
        const pendingFeatures = await this.loadPendingFeatures(
          this.config!.projectPath
        );

        if (pendingFeatures.length === 0) {
          this.emitAutoModeEvent("auto_mode_idle", {
            message: "No pending features - auto mode idle",
            projectPath: this.config!.projectPath,
          });
          await this.sleep(10000);
          continue;
        }

        // Find a feature not currently running
        const nextFeature = pendingFeatures.find(
          (f) => !this.runningFeatures.has(f.id)
        );

        if (nextFeature) {
          // Start feature execution in background
          this.executeFeature(
            this.config!.projectPath,
            nextFeature.id,
            this.config!.useWorktrees,
            true
          ).catch((error) => {
            console.error(`[AutoMode] Feature ${nextFeature.id} error:`, error);
          });
        }

        await this.sleep(2000);
      } catch (error) {
        console.error("[AutoMode] Loop iteration error:", error);
        await this.sleep(5000);
      }
    }

    this.autoLoopRunning = false;
  }

  /**
   * Stop the auto mode loop
   */
  async stopAutoLoop(): Promise<number> {
    const wasRunning = this.autoLoopRunning;
    this.autoLoopRunning = false;
    if (this.autoLoopAbortController) {
      this.autoLoopAbortController.abort();
      this.autoLoopAbortController = null;
    }

    // Emit stop event immediately when user explicitly stops
    if (wasRunning) {
      this.emitAutoModeEvent("auto_mode_stopped", {
        message: "Auto mode stopped",
        projectPath: this.config?.projectPath,
      });
    }

    return this.runningFeatures.size;
  }

  /**
   * Execute a single feature
   */
  async executeFeature(
    projectPath: string,
    featureId: string,
    useWorktrees = true,
    isAutoMode = false,
    customPrompt?: string
  ): Promise<void> {
    if (this.runningFeatures.has(featureId)) {
      throw new Error(`Feature ${featureId} is already running`);
    }

    const abortController = new AbortController();
    const branchName = `feature/${featureId}`;
    let worktreePath: string | null = null;

    // Setup worktree if enabled
    if (useWorktrees) {
      worktreePath = await this.setupWorktree(
        projectPath,
        featureId,
        branchName
      );
    }

    const workDir = worktreePath || projectPath;

    this.runningFeatures.set(featureId, {
      featureId,
      projectPath,
      worktreePath,
      branchName,
      abortController,
      isAutoMode,
      startTime: Date.now(),
    });

    // Emit feature start event
    this.emitAutoModeEvent("auto_mode_feature_start", {
      featureId,
      projectPath,
      feature: {
        id: featureId,
        title: "Loading...",
        description: "Feature is starting",
      },
    });

    try {
      // Load feature details
      const feature = await this.loadFeature(projectPath, featureId);
      if (!feature) {
        throw new Error(`Feature ${featureId} not found`);
      }

      // Update feature status to in_progress
      await this.updateFeatureStatus(projectPath, featureId, "in_progress");

      // Use custom prompt if provided, otherwise build the prompt with planning phase
      let prompt: string;
      if (customPrompt) {
        prompt = customPrompt;
      } else {
        const featurePrompt = this.buildFeaturePrompt(feature);
        const planningPrefix = this.getPlanningPromptPrefix(feature);
        prompt = planningPrefix + featurePrompt;
      }

      // Emit planning mode info
      if (feature.planningMode && feature.planningMode !== 'skip') {
        this.emitAutoModeEvent('planning_started', {
          featureId: feature.id,
          mode: feature.planningMode,
          message: `Starting ${feature.planningMode} planning phase`
        });
      }

      // Extract image paths from feature
      const imagePaths = feature.imagePaths?.map((img) =>
        typeof img === "string" ? img : img.path
      );

      // Get model from feature
      const model = resolveModelString(feature.model, DEFAULT_MODELS.claude);
      console.log(
        `[AutoMode] Executing feature ${featureId} with model: ${model}`
      );

      // Run the agent with the feature's model and images
      await this.runAgent(
        workDir,
        featureId,
        prompt,
        abortController,
        imagePaths,
        model,
        {
          projectPath,
          planningMode: feature.planningMode,
          requirePlanApproval: feature.requirePlanApproval,
        }
      );

      // Mark as waiting_approval for user review
      await this.updateFeatureStatus(
        projectPath,
        featureId,
        "waiting_approval"
      );

      this.emitAutoModeEvent("auto_mode_feature_complete", {
        featureId,
        passes: true,
        message: `Feature completed in ${Math.round(
          (Date.now() - this.runningFeatures.get(featureId)!.startTime) / 1000
        )}s`,
        projectPath,
      });
    } catch (error) {
      const errorInfo = classifyError(error);

      if (errorInfo.isAbort) {
        this.emitAutoModeEvent("auto_mode_feature_complete", {
          featureId,
          passes: false,
          message: "Feature stopped by user",
          projectPath,
        });
      } else {
        console.error(`[AutoMode] Feature ${featureId} failed:`, error);
        await this.updateFeatureStatus(projectPath, featureId, "backlog");
        this.emitAutoModeEvent("auto_mode_error", {
          featureId,
          error: errorInfo.message,
          errorType: errorInfo.isAuth ? "authentication" : "execution",
          projectPath,
        });
      }
    } finally {
      console.log(`[AutoMode] Feature ${featureId} execution ended, cleaning up runningFeatures`);
      console.log(`[AutoMode] Pending approvals at cleanup: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`);
      this.runningFeatures.delete(featureId);
    }
  }

  /**
   * Stop a specific feature
   */
  async stopFeature(featureId: string): Promise<boolean> {
    const running = this.runningFeatures.get(featureId);
    if (!running) {
      return false;
    }

    // Cancel any pending plan approval for this feature
    this.cancelPlanApproval(featureId);

    running.abortController.abort();
    return true;
  }

  /**
   * Resume a feature (continues from saved context)
   */
  async resumeFeature(
    projectPath: string,
    featureId: string,
    useWorktrees = true
  ): Promise<void> {
    // Check if context exists
    const contextPath = path.join(
      projectPath,
      ".automaker",
      "features",
      featureId,
      "agent-output.md"
    );

    let hasContext = false;
    try {
      await fs.access(contextPath);
      hasContext = true;
    } catch {
      // No context
    }

    if (hasContext) {
      // Load previous context and continue
      const context = await fs.readFile(contextPath, "utf-8");
      return this.executeFeatureWithContext(
        projectPath,
        featureId,
        context,
        useWorktrees
      );
    }

    // No context, start fresh
    return this.executeFeature(projectPath, featureId, useWorktrees, false);
  }

  /**
   * Follow up on a feature with additional instructions
   */
  async followUpFeature(
    projectPath: string,
    featureId: string,
    prompt: string,
    imagePaths?: string[]
  ): Promise<void> {
    if (this.runningFeatures.has(featureId)) {
      throw new Error(`Feature ${featureId} is already running`);
    }

    const abortController = new AbortController();

    // Check if worktree exists
    const worktreePath = path.join(
      projectPath,
      ".automaker",
      "worktrees",
      featureId
    );
    let workDir = projectPath;

    try {
      await fs.access(worktreePath);
      workDir = worktreePath;
    } catch {
      // No worktree, use project path
    }

    // Load feature info for context
    const feature = await this.loadFeature(projectPath, featureId);

    // Load previous agent output if it exists
    const contextPath = path.join(
      projectPath,
      ".automaker",
      "features",
      featureId,
      "agent-output.md"
    );
    let previousContext = "";
    try {
      previousContext = await fs.readFile(contextPath, "utf-8");
    } catch {
      // No previous context
    }

    // Build complete prompt with feature info, previous context, and follow-up instructions
    let fullPrompt = `## Follow-up on Feature Implementation

${feature ? this.buildFeaturePrompt(feature) : `**Feature ID:** ${featureId}`}
`;

    if (previousContext) {
      fullPrompt += `
## Previous Agent Work
The following is the output from the previous implementation attempt:

${previousContext}
`;
    }

    fullPrompt += `
## Follow-up Instructions
${prompt}

## Task
Address the follow-up instructions above. Review the previous work and make the requested changes or fixes.`;

    this.runningFeatures.set(featureId, {
      featureId,
      projectPath,
      worktreePath: workDir !== projectPath ? worktreePath : null,
      branchName: `feature/${featureId}`,
      abortController,
      isAutoMode: false,
      startTime: Date.now(),
    });

    this.emitAutoModeEvent("auto_mode_feature_start", {
      featureId,
      projectPath,
      feature: feature || {
        id: featureId,
        title: "Follow-up",
        description: prompt.substring(0, 100),
      },
    });

    try {
      // Get model from feature (already loaded above)
      const model = resolveModelString(feature?.model, DEFAULT_MODELS.claude);
      console.log(
        `[AutoMode] Follow-up for feature ${featureId} using model: ${model}`
      );

      // Update feature status to in_progress
      await this.updateFeatureStatus(projectPath, featureId, "in_progress");

      // Copy follow-up images to feature folder
      const copiedImagePaths: string[] = [];
      if (imagePaths && imagePaths.length > 0) {
        const featureImagesDir = path.join(
          projectPath,
          ".automaker",
          "features",
          featureId,
          "images"
        );

        await fs.mkdir(featureImagesDir, { recursive: true });

        for (const imagePath of imagePaths) {
          try {
            // Get the filename from the path
            const filename = path.basename(imagePath);
            const destPath = path.join(featureImagesDir, filename);

            // Copy the image
            await fs.copyFile(imagePath, destPath);

            // Store the relative path (like FeatureLoader does)
            const relativePath = path.join(
              ".automaker",
              "features",
              featureId,
              "images",
              filename
            );
            copiedImagePaths.push(relativePath);
          } catch (error) {
            console.error(
              `[AutoMode] Failed to copy follow-up image ${imagePath}:`,
              error
            );
          }
        }
      }

      // Update feature object with new follow-up images BEFORE building prompt
      if (copiedImagePaths.length > 0 && feature) {
        const currentImagePaths = feature.imagePaths || [];
        const newImagePaths = copiedImagePaths.map((p) => ({
          path: p,
          filename: path.basename(p),
          mimeType: "image/png", // Default, could be improved
        }));

        feature.imagePaths = [...currentImagePaths, ...newImagePaths];
      }

      // Combine original feature images with new follow-up images
      const allImagePaths: string[] = [];

      // Add all images from feature (now includes both original and new)
      if (feature?.imagePaths) {
        const allPaths = feature.imagePaths.map((img) =>
          typeof img === "string" ? img : img.path
        );
        allImagePaths.push(...allPaths);
      }

      // Save updated feature.json with new images
      if (copiedImagePaths.length > 0 && feature) {
        const featurePath = path.join(
          projectPath,
          ".automaker",
          "features",
          featureId,
          "feature.json"
        );

        try {
          await fs.writeFile(featurePath, JSON.stringify(feature, null, 2));
        } catch (error) {
          console.error(`[AutoMode] Failed to save feature.json:`, error);
        }
      }

      // Use fullPrompt (already built above) with model and all images
      // Note: Follow-ups skip planning mode - they continue from previous work
      await this.runAgent(
        workDir,
        featureId,
        fullPrompt,
        abortController,
        allImagePaths.length > 0 ? allImagePaths : imagePaths,
        model,
        {
          projectPath,
          planningMode: 'skip', // Follow-ups don't require approval
        }
      );

      // Mark as waiting_approval for user review
      await this.updateFeatureStatus(
        projectPath,
        featureId,
        "waiting_approval"
      );

      this.emitAutoModeEvent("auto_mode_feature_complete", {
        featureId,
        passes: true,
        message: "Follow-up completed successfully",
        projectPath,
      });
    } catch (error) {
      if (!isAbortError(error)) {
        this.emitAutoModeEvent("auto_mode_error", {
          featureId,
          error: (error as Error).message,
          projectPath,
        });
      }
    } finally {
      this.runningFeatures.delete(featureId);
    }
  }

  /**
   * Verify a feature's implementation
   */
  async verifyFeature(
    projectPath: string,
    featureId: string
  ): Promise<boolean> {
    const worktreePath = path.join(
      projectPath,
      ".automaker",
      "worktrees",
      featureId
    );
    let workDir = projectPath;

    try {
      await fs.access(worktreePath);
      workDir = worktreePath;
    } catch {
      // No worktree
    }

    // Run verification - check if tests pass, build works, etc.
    const verificationChecks = [
      { cmd: "npm run lint", name: "Lint" },
      { cmd: "npm run typecheck", name: "Type check" },
      { cmd: "npm test", name: "Tests" },
      { cmd: "npm run build", name: "Build" },
    ];

    let allPassed = true;
    const results: Array<{ check: string; passed: boolean; output?: string }> =
      [];

    for (const check of verificationChecks) {
      try {
        const { stdout, stderr } = await execAsync(check.cmd, {
          cwd: workDir,
          timeout: 120000,
        });
        results.push({
          check: check.name,
          passed: true,
          output: stdout || stderr,
        });
      } catch (error) {
        allPassed = false;
        results.push({
          check: check.name,
          passed: false,
          output: (error as Error).message,
        });
        break; // Stop on first failure
      }
    }

    this.emitAutoModeEvent("auto_mode_feature_complete", {
      featureId,
      passes: allPassed,
      message: allPassed
        ? "All verification checks passed"
        : `Verification failed: ${
            results.find((r) => !r.passed)?.check || "Unknown"
          }`,
    });

    return allPassed;
  }

  /**
   * Commit feature changes
   */
  async commitFeature(
    projectPath: string,
    featureId: string
  ): Promise<string | null> {
    const worktreePath = path.join(
      projectPath,
      ".automaker",
      "worktrees",
      featureId
    );
    let workDir = projectPath;

    try {
      await fs.access(worktreePath);
      workDir = worktreePath;
    } catch {
      // No worktree
    }

    try {
      // Check for changes
      const { stdout: status } = await execAsync("git status --porcelain", {
        cwd: workDir,
      });
      if (!status.trim()) {
        return null; // No changes
      }

      // Load feature for commit message
      const feature = await this.loadFeature(projectPath, featureId);
      const commitMessage = feature
        ? `feat: ${this.extractTitleFromDescription(
            feature.description
          )}\n\nImplemented by Automaker auto-mode`
        : `feat: Feature ${featureId}`;

      // Stage and commit
      await execAsync("git add -A", { cwd: workDir });
      await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
        cwd: workDir,
      });

      // Get commit hash
      const { stdout: hash } = await execAsync("git rev-parse HEAD", {
        cwd: workDir,
      });

      this.emitAutoModeEvent("auto_mode_feature_complete", {
        featureId,
        passes: true,
        message: `Changes committed: ${hash.trim().substring(0, 8)}`,
      });

      return hash.trim();
    } catch (error) {
      console.error(`[AutoMode] Commit failed for ${featureId}:`, error);
      return null;
    }
  }

  /**
   * Check if context exists for a feature
   */
  async contextExists(
    projectPath: string,
    featureId: string
  ): Promise<boolean> {
    const contextPath = path.join(
      projectPath,
      ".automaker",
      "features",
      featureId,
      "agent-output.md"
    );

    try {
      await fs.access(contextPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Analyze project to gather context
   */
  async analyzeProject(projectPath: string): Promise<void> {
    const abortController = new AbortController();

    const analysisFeatureId = `analysis-${Date.now()}`;
    this.emitAutoModeEvent("auto_mode_feature_start", {
      featureId: analysisFeatureId,
      projectPath,
      feature: {
        id: analysisFeatureId,
        title: "Project Analysis",
        description: "Analyzing project structure",
      },
    });

    const prompt = `Analyze this project and provide a summary of:
1. Project structure and architecture
2. Main technologies and frameworks used
3. Key components and their responsibilities
4. Build and test commands
5. Any existing conventions or patterns

Format your response as a structured markdown document.`;

    try {
      // Use default Claude model for analysis (can be overridden in the future)
      const analysisModel = resolveModelString(
        undefined,
        DEFAULT_MODELS.claude
      );
      const provider = ProviderFactory.getProviderForModel(analysisModel);

      const options: ExecuteOptions = {
        prompt,
        model: analysisModel,
        maxTurns: 5,
        cwd: projectPath,
        allowedTools: ["Read", "Glob", "Grep"],
        abortController,
      };

      const stream = provider.executeQuery(options);
      let analysisResult = "";

      for await (const msg of stream) {
        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              analysisResult = block.text || "";
              this.emitAutoModeEvent("auto_mode_progress", {
                featureId: analysisFeatureId,
                content: block.text,
                projectPath,
              });
            }
          }
        } else if (msg.type === "result" && msg.subtype === "success") {
          analysisResult = msg.result || analysisResult;
        }
      }

      // Save analysis
      const analysisPath = path.join(
        projectPath,
        ".automaker",
        "project-analysis.md"
      );
      await fs.mkdir(path.dirname(analysisPath), { recursive: true });
      await fs.writeFile(analysisPath, analysisResult);

      this.emitAutoModeEvent("auto_mode_feature_complete", {
        featureId: analysisFeatureId,
        passes: true,
        message: "Project analysis completed",
        projectPath,
      });
    } catch (error) {
      this.emitAutoModeEvent("auto_mode_error", {
        featureId: analysisFeatureId,
        error: (error as Error).message,
        projectPath,
      });
    }
  }

  /**
   * Get current status
   */
  getStatus(): {
    isRunning: boolean;
    autoLoopRunning: boolean;
    runningFeatures: string[];
    runningCount: number;
  } {
    return {
      isRunning: this.autoLoopRunning || this.runningFeatures.size > 0,
      autoLoopRunning: this.autoLoopRunning,
      runningFeatures: Array.from(this.runningFeatures.keys()),
      runningCount: this.runningFeatures.size,
    };
  }

  /**
   * Get detailed info about all running agents
   */
  getRunningAgents(): Array<{
    featureId: string;
    projectPath: string;
    projectName: string;
    isAutoMode: boolean;
  }> {
    return Array.from(this.runningFeatures.values()).map((rf) => ({
      featureId: rf.featureId,
      projectPath: rf.projectPath,
      projectName: path.basename(rf.projectPath),
      isAutoMode: rf.isAutoMode,
    }));
  }

  /**
   * Wait for plan approval from the user.
   * Returns a promise that resolves when the user approves/rejects the plan.
   */
  waitForPlanApproval(
    featureId: string,
    projectPath: string
  ): Promise<{ approved: boolean; editedPlan?: string; feedback?: string }> {
    console.log(`[AutoMode] Registering pending approval for feature ${featureId}`);
    console.log(`[AutoMode] Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`);
    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(featureId, {
        resolve,
        reject,
        featureId,
        projectPath,
      });
      console.log(`[AutoMode] Pending approval registered for feature ${featureId}`);
    });
  }

  /**
   * Resolve a pending plan approval.
   * Called when the user approves or rejects the plan via API.
   */
  async resolvePlanApproval(
    featureId: string,
    approved: boolean,
    editedPlan?: string,
    feedback?: string,
    projectPathFromClient?: string
  ): Promise<{ success: boolean; error?: string }> {
    console.log(`[AutoMode] resolvePlanApproval called for feature ${featureId}, approved=${approved}`);
    console.log(`[AutoMode] Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`);
    const pending = this.pendingApprovals.get(featureId);

    if (!pending) {
      console.log(`[AutoMode] No pending approval in Map for feature ${featureId}`);

      // RECOVERY: If no pending approval but we have projectPath from client,
      // check if feature's planSpec.status is 'generated' and handle recovery
      if (projectPathFromClient) {
        console.log(`[AutoMode] Attempting recovery with projectPath: ${projectPathFromClient}`);
        const feature = await this.loadFeature(projectPathFromClient, featureId);

        if (feature?.planSpec?.status === 'generated') {
          console.log(`[AutoMode] Feature ${featureId} has planSpec.status='generated', performing recovery`);

          if (approved) {
            // Update planSpec to approved
            await this.updateFeaturePlanSpec(projectPathFromClient, featureId, {
              status: 'approved',
              approvedAt: new Date().toISOString(),
              reviewedByUser: true,
              content: editedPlan || feature.planSpec.content,
            });

            // Build continuation prompt and re-run the feature
            const planContent = editedPlan || feature.planSpec.content || '';
            let continuationPrompt = `The plan/specification has been approved. `;
            if (feedback) {
              continuationPrompt += `\n\nUser feedback: ${feedback}\n\n`;
            }
            continuationPrompt += `Now proceed with the implementation as specified in the plan:\n\n${planContent}\n\nImplement the feature now.`;

            console.log(`[AutoMode] Starting recovery execution for feature ${featureId}`);

            // Start feature execution with the continuation prompt (async, don't await)
            this.executeFeature(projectPathFromClient, featureId, true, false, continuationPrompt)
              .catch((error) => {
                console.error(`[AutoMode] Recovery execution failed for feature ${featureId}:`, error);
              });

            return { success: true };
          } else {
            // Rejected - update status and emit event
            await this.updateFeaturePlanSpec(projectPathFromClient, featureId, {
              status: 'rejected',
              reviewedByUser: true,
            });

            await this.updateFeatureStatus(projectPathFromClient, featureId, 'backlog');

            this.emitAutoModeEvent('plan_rejected', {
              featureId,
              projectPath: projectPathFromClient,
              feedback,
            });

            return { success: true };
          }
        }
      }

      console.log(`[AutoMode] ERROR: No pending approval found for feature ${featureId} and recovery not possible`);
      return { success: false, error: `No pending approval for feature ${featureId}` };
    }
    console.log(`[AutoMode] Found pending approval for feature ${featureId}, proceeding...`);

    const { projectPath } = pending;

    // Update feature's planSpec status
    await this.updateFeaturePlanSpec(projectPath, featureId, {
      status: approved ? 'approved' : 'rejected',
      approvedAt: approved ? new Date().toISOString() : undefined,
      reviewedByUser: true,
      content: editedPlan, // Update content if user provided an edited version
    });

    // If rejected with feedback, we can store it for the user to see
    if (!approved && feedback) {
      // Emit event so client knows the rejection reason
      this.emitAutoModeEvent('plan_rejected', {
        featureId,
        projectPath,
        feedback,
      });
    }

    // Resolve the promise with all data including feedback
    pending.resolve({ approved, editedPlan, feedback });
    this.pendingApprovals.delete(featureId);

    return { success: true };
  }

  /**
   * Cancel a pending plan approval (e.g., when feature is stopped).
   */
  cancelPlanApproval(featureId: string): void {
    console.log(`[AutoMode] cancelPlanApproval called for feature ${featureId}`);
    console.log(`[AutoMode] Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`);
    const pending = this.pendingApprovals.get(featureId);
    if (pending) {
      console.log(`[AutoMode] Found and cancelling pending approval for feature ${featureId}`);
      pending.reject(new Error('Plan approval cancelled - feature was stopped'));
      this.pendingApprovals.delete(featureId);
    } else {
      console.log(`[AutoMode] No pending approval to cancel for feature ${featureId}`);
    }
  }

  /**
   * Check if a feature has a pending plan approval.
   */
  hasPendingApproval(featureId: string): boolean {
    return this.pendingApprovals.has(featureId);
  }

  // Private helpers

  private async setupWorktree(
    projectPath: string,
    featureId: string,
    branchName: string
  ): Promise<string> {
    const worktreesDir = path.join(projectPath, ".automaker", "worktrees");
    const worktreePath = path.join(worktreesDir, featureId);

    await fs.mkdir(worktreesDir, { recursive: true });

    // Check if worktree already exists
    try {
      await fs.access(worktreePath);
      return worktreePath;
    } catch {
      // Create new worktree
    }

    // Create branch if it doesn't exist
    try {
      await execAsync(`git branch ${branchName}`, { cwd: projectPath });
    } catch {
      // Branch may already exist
    }

    // Create worktree
    try {
      await execAsync(`git worktree add "${worktreePath}" ${branchName}`, {
        cwd: projectPath,
      });
    } catch (error) {
      // Worktree creation failed, fall back to direct execution
      console.error(`[AutoMode] Worktree creation failed:`, error);
      return projectPath;
    }

    return worktreePath;
  }

  private async loadFeature(
    projectPath: string,
    featureId: string
  ): Promise<Feature | null> {
    const featurePath = path.join(
      projectPath,
      ".automaker",
      "features",
      featureId,
      "feature.json"
    );

    try {
      const data = await fs.readFile(featurePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private async updateFeatureStatus(
    projectPath: string,
    featureId: string,
    status: string
  ): Promise<void> {
    const featurePath = path.join(
      projectPath,
      ".automaker",
      "features",
      featureId,
      "feature.json"
    );

    try {
      const data = await fs.readFile(featurePath, "utf-8");
      const feature = JSON.parse(data);
      feature.status = status;
      feature.updatedAt = new Date().toISOString();
      // Set justFinishedAt timestamp when moving to waiting_approval (agent just completed)
      // Badge will show for 2 minutes after this timestamp
      if (status === "waiting_approval") {
        feature.justFinishedAt = new Date().toISOString();
      } else {
        // Clear the timestamp when moving to other statuses
        feature.justFinishedAt = undefined;
      }
      await fs.writeFile(featurePath, JSON.stringify(feature, null, 2));
    } catch {
      // Feature file may not exist
    }
  }

  /**
   * Update the planSpec of a feature
   */
  private async updateFeaturePlanSpec(
    projectPath: string,
    featureId: string,
    updates: Partial<PlanSpec>
  ): Promise<void> {
    const featurePath = path.join(
      projectPath,
      ".automaker",
      "features",
      featureId,
      "feature.json"
    );

    try {
      const data = await fs.readFile(featurePath, "utf-8");
      const feature = JSON.parse(data);

      // Initialize planSpec if it doesn't exist
      if (!feature.planSpec) {
        feature.planSpec = {
          status: 'pending',
          version: 1,
          reviewedByUser: false,
        };
      }

      // Apply updates
      Object.assign(feature.planSpec, updates);

      // If content is being updated and it's a new version, increment version
      if (updates.content && updates.content !== feature.planSpec.content) {
        feature.planSpec.version = (feature.planSpec.version || 0) + 1;
      }

      feature.updatedAt = new Date().toISOString();
      await fs.writeFile(featurePath, JSON.stringify(feature, null, 2));
    } catch (error) {
      console.error(`[AutoMode] Failed to update planSpec for ${featureId}:`, error);
    }
  }

  private async loadPendingFeatures(projectPath: string): Promise<Feature[]> {
    const featuresDir = path.join(projectPath, ".automaker", "features");

    try {
      const entries = await fs.readdir(featuresDir, { withFileTypes: true });
      const features: Feature[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const featurePath = path.join(
            featuresDir,
            entry.name,
            "feature.json"
          );
          try {
            const data = await fs.readFile(featurePath, "utf-8");
            const feature = JSON.parse(data);
            if (
              feature.status === "pending" ||
              feature.status === "ready" ||
              feature.status === "backlog"
            ) {
              features.push(feature);
            }
          } catch {
            // Skip invalid features
          }
        }
      }

      // Sort by priority
      return features.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    } catch {
      return [];
    }
  }

  /**
   * Extract a title from feature description (first line or truncated)
   */
  private extractTitleFromDescription(description: string): string {
    if (!description || !description.trim()) {
      return "Untitled Feature";
    }

    // Get first line, or first 60 characters if no newline
    const firstLine = description.split("\n")[0].trim();
    if (firstLine.length <= 60) {
      return firstLine;
    }

    // Truncate to 60 characters and add ellipsis
    return firstLine.substring(0, 57) + "...";
  }

  /**
   * Get the planning prompt prefix based on feature's planning mode
   */
  private getPlanningPromptPrefix(feature: Feature): string {
    const mode = feature.planningMode || 'skip';

    if (mode === 'skip') {
      return ''; // No planning phase
    }

    // For lite mode, use the approval variant if requirePlanApproval is true
    let promptKey: string = mode;
    if (mode === 'lite' && feature.requirePlanApproval === true) {
      promptKey = 'lite_with_approval';
    }

    const planningPrompt = PLANNING_PROMPTS[promptKey as keyof typeof PLANNING_PROMPTS];
    if (!planningPrompt) {
      return '';
    }

    return planningPrompt + '\n\n---\n\n## Feature Request\n\n';
  }

  private buildFeaturePrompt(feature: Feature): string {
    const title = this.extractTitleFromDescription(feature.description);

    let prompt = `## Feature Implementation Task

**Feature ID:** ${feature.id}
**Title:** ${title}
**Description:** ${feature.description}
`;

    if (feature.spec) {
      prompt += `
**Specification:**
${feature.spec}
`;
    }

    // Add images note (like old implementation)
    if (feature.imagePaths && feature.imagePaths.length > 0) {
      const imagesList = feature.imagePaths
        .map((img, idx) => {
          const path = typeof img === "string" ? img : img.path;
          const filename =
            typeof img === "string"
              ? path.split("/").pop()
              : img.filename || path.split("/").pop();
          const mimeType =
            typeof img === "string" ? "image/*" : img.mimeType || "image/*";
          return `   ${
            idx + 1
          }. ${filename} (${mimeType})\n      Path: ${path}`;
        })
        .join("\n");

      prompt += `
**📎 Context Images Attached:**
The user has attached ${feature.imagePaths.length} image(s) for context. These images are provided both visually (in the initial message) and as files you can read:

${imagesList}

You can use the Read tool to view these images at any time during implementation. Review them carefully before implementing.
`;
    }

    prompt += `
## Instructions

Implement this feature by:
1. First, explore the codebase to understand the existing structure
2. Plan your implementation approach
3. Write the necessary code changes
4. Add or update tests as needed
5. Ensure the code follows existing patterns and conventions

When done, summarize what you implemented and any notes for the developer.`;

    return prompt;
  }

  private async runAgent(
    workDir: string,
    featureId: string,
    prompt: string,
    abortController: AbortController,
    imagePaths?: string[],
    model?: string,
    options?: {
      projectPath?: string;
      planningMode?: PlanningMode;
      requirePlanApproval?: boolean;
    }
  ): Promise<void> {
    const projectPath = options?.projectPath || workDir;
    const planningMode = options?.planningMode || 'skip';
    // Check if this planning mode can generate a spec/plan that needs approval
    // - spec and full always generate specs
    // - lite only generates approval-ready content when requirePlanApproval is true
    const planningModeRequiresApproval =
      planningMode === 'spec' ||
      planningMode === 'full' ||
      (planningMode === 'lite' && options?.requirePlanApproval === true);
    const requiresApproval = planningModeRequiresApproval && options?.requirePlanApproval === true;

    // Build SDK options using centralized configuration for feature implementation
    const sdkOptions = createAutoModeOptions({
      cwd: workDir,
      model: model,
      abortController,
    });

    // Extract model, maxTurns, and allowedTools from SDK options
    const finalModel = sdkOptions.model!;
    const maxTurns = sdkOptions.maxTurns;
    const allowedTools = sdkOptions.allowedTools as string[] | undefined;

    console.log(
      `[AutoMode] runAgent called for feature ${featureId} with model: ${finalModel}, planningMode: ${planningMode}, requiresApproval: ${requiresApproval}`
    );

    // Get provider for this model
    const provider = ProviderFactory.getProviderForModel(finalModel);

    console.log(
      `[AutoMode] Using provider "${provider.getName()}" for model "${finalModel}"`
    );

    // Build prompt content with images using utility
    const { content: promptContent } = await buildPromptWithImages(
      prompt,
      imagePaths,
      workDir,
      false // don't duplicate paths in text
    );

    const executeOptions: ExecuteOptions = {
      prompt: promptContent,
      model: finalModel,
      maxTurns: maxTurns,
      cwd: workDir,
      allowedTools: allowedTools,
      abortController,
    };

    // Execute via provider
    const stream = provider.executeQuery(executeOptions);
    let responseText = "";
    let specDetected = false;
    const outputPath = path.join(
      workDir,
      ".automaker",
      "features",
      featureId,
      "agent-output.md"
    );

    streamLoop: for await (const msg of stream) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            responseText += block.text || "";

            // Check for authentication errors in the response
            if (
              block.text &&
              (block.text.includes("Invalid API key") ||
                block.text.includes("authentication_failed") ||
                block.text.includes("Fix external API key"))
            ) {
              throw new Error(
                "Authentication failed: Invalid or expired API key. " +
                  "Please check your ANTHROPIC_API_KEY or GOOGLE_API_KEY, or run 'claude login' to re-authenticate."
              );
            }

            // Check for [SPEC_GENERATED] marker in planning modes (spec or full)
            if (planningModeRequiresApproval && !specDetected && responseText.includes('[SPEC_GENERATED]')) {
              specDetected = true;

              // Extract plan content (everything before the marker)
              const markerIndex = responseText.indexOf('[SPEC_GENERATED]');
              const planContent = responseText.substring(0, markerIndex).trim();

              // Parse tasks from the generated spec (for spec and full modes)
              const parsedTasks = parseTasksFromSpec(planContent);
              const tasksTotal = parsedTasks.length;

              console.log(`[AutoMode] Parsed ${tasksTotal} tasks from spec for feature ${featureId}`);
              if (parsedTasks.length > 0) {
                console.log(`[AutoMode] Tasks: ${parsedTasks.map(t => t.id).join(', ')}`);
              }

              // Update planSpec status to 'generated' and save content with parsed tasks
              await this.updateFeaturePlanSpec(projectPath, featureId, {
                status: 'generated',
                content: planContent,
                version: 1,
                generatedAt: new Date().toISOString(),
                reviewedByUser: false,
                tasks: parsedTasks,
                tasksTotal,
                tasksCompleted: 0,
              });

              let approvedPlanContent = planContent;
              let userFeedback: string | undefined;

              // Only pause for approval if requirePlanApproval is true
              if (requiresApproval) {
                console.log(`[AutoMode] Spec generated for feature ${featureId}, waiting for approval`);

                // CRITICAL: Register pending approval BEFORE emitting event
                // This prevents race condition where frontend tries to approve before
                // the approval is registered in pendingApprovals Map
                const approvalPromise = this.waitForPlanApproval(featureId, projectPath);

                // NOW emit plan_approval_required event (approval is already registered)
                this.emitAutoModeEvent('plan_approval_required', {
                  featureId,
                  projectPath,
                  planContent,
                  planningMode,
                });

                // Wait for user approval
                try {
                  const approvalResult = await approvalPromise;

                  if (!approvalResult.approved) {
                    // User rejected the plan - abort feature execution
                    console.log(`[AutoMode] Plan rejected for feature ${featureId}`);
                    throw new Error('Plan rejected by user');
                  }

                  console.log(`[AutoMode] Plan approved for feature ${featureId}, continuing with implementation`);

                  // If user provided an edited plan, update the planSpec content
                  if (approvalResult.editedPlan) {
                    approvedPlanContent = approvalResult.editedPlan;
                    await this.updateFeaturePlanSpec(projectPath, featureId, {
                      content: approvalResult.editedPlan,
                    });
                  }

                  // Capture user feedback if provided
                  userFeedback = approvalResult.feedback;

                  // Emit event to notify implementation is starting
                  this.emitAutoModeEvent('plan_approved', {
                    featureId,
                    projectPath,
                    hasEdits: !!approvalResult.editedPlan,
                  });

                } catch (error) {
                  if ((error as Error).message.includes('cancelled')) {
                    throw error; // Re-throw cancellation errors
                  }
                  throw new Error(`Plan approval failed: ${(error as Error).message}`);
                }
              } else {
                // Auto-approve: requirePlanApproval is false, just continue without pausing
                console.log(`[AutoMode] Spec generated for feature ${featureId}, auto-approving (requirePlanApproval=false)`);

                // Emit info event for frontend
                this.emitAutoModeEvent('plan_auto_approved', {
                  featureId,
                  projectPath,
                  planContent,
                  planningMode,
                });
              }

              // CRITICAL: After approval, we need to make a second call to continue implementation
              // The agent is waiting for "approved" - we need to send it and continue
              console.log(`[AutoMode] Making continuation call after plan approval for feature ${featureId}`);

              // Update planSpec status to approved (handles both manual and auto-approval paths)
              await this.updateFeaturePlanSpec(projectPath, featureId, {
                status: 'approved',
                approvedAt: new Date().toISOString(),
                reviewedByUser: requiresApproval,
              });

              // Build continuation prompt
              let continuationPrompt = `The plan/specification has been approved. `;
              if (userFeedback) {
                continuationPrompt += `\n\nUser feedback: ${userFeedback}\n\n`;
              }
              continuationPrompt += `Now proceed with the implementation as specified in the plan:\n\n${approvedPlanContent}\n\nImplement the feature now.`;

              // Make continuation call
              const continuationStream = provider.executeQuery({
                prompt: continuationPrompt,
                model: finalModel,
                maxTurns: maxTurns,
                cwd: workDir,
                allowedTools: allowedTools,
                abortController,
              });

              // Track task progress for events
              let startedTaskIds: string[] = [];
              let completedTaskIds: string[] = [];
              let currentPhaseNum = 1;
              let currentTaskId: string | null = null;

              // Process continuation stream with task progress tracking
              for await (const contMsg of continuationStream) {
                if (contMsg.type === "assistant" && contMsg.message?.content) {
                  for (const contBlock of contMsg.message.content) {
                    if (contBlock.type === "text") {
                      responseText += contBlock.text || "";

                      // Check for [TASK_START] markers - detect when task begins
                      const taskStartMatches = responseText.match(/\[TASK_START\]\s*(T\d{3})/g);
                      if (taskStartMatches) {
                        for (const match of taskStartMatches) {
                          const taskIdMatch = match.match(/T\d{3}/);
                          if (taskIdMatch && !startedTaskIds.includes(taskIdMatch[0])) {
                            const taskId = taskIdMatch[0];
                            startedTaskIds.push(taskId);
                            currentTaskId = taskId;

                            // Find task details from parsed tasks
                            const taskInfo = parsedTasks.find(t => t.id === taskId);
                            const taskDescription = taskInfo?.description || 'Working on task';

                            console.log(`[AutoMode] Task ${taskId} started for feature ${featureId}: ${taskDescription}`);

                            // Emit task started event
                            this.emitAutoModeEvent("auto_mode_task_started", {
                              featureId,
                              projectPath,
                              taskId,
                              taskDescription,
                              taskIndex: startedTaskIds.length - 1,
                              tasksTotal: parsedTasks.length,
                            });

                            // Update planSpec with current task
                            await this.updateFeaturePlanSpec(projectPath, featureId, {
                              currentTaskId: taskId,
                            });
                          }
                        }
                      }

                      // Check for [TASK_COMPLETE] markers
                      const taskCompleteMatches = responseText.match(/\[TASK_COMPLETE\]\s*(T\d{3})/g);
                      if (taskCompleteMatches) {
                        for (const match of taskCompleteMatches) {
                          const taskIdMatch = match.match(/T\d{3}/);
                          if (taskIdMatch && !completedTaskIds.includes(taskIdMatch[0])) {
                            const taskId = taskIdMatch[0];
                            completedTaskIds.push(taskId);

                            console.log(`[AutoMode] Task ${taskId} completed for feature ${featureId}`);

                            // Emit task completion event
                            this.emitAutoModeEvent("auto_mode_task_complete", {
                              featureId,
                              projectPath,
                              taskId,
                              tasksCompleted: completedTaskIds.length,
                              tasksTotal: parsedTasks.length,
                            });

                            // Update planSpec with task progress
                            await this.updateFeaturePlanSpec(projectPath, featureId, {
                              tasksCompleted: completedTaskIds.length,
                              currentTaskId: taskId,
                            });
                          }
                        }
                      }

                      // Check for [PHASE_COMPLETE] markers (for full mode)
                      const phaseCompleteMatch = contBlock.text?.match(/\[PHASE_COMPLETE\]\s*Phase\s*(\d+)/i);
                      if (phaseCompleteMatch) {
                        const phaseNum = parseInt(phaseCompleteMatch[1], 10);
                        if (phaseNum > currentPhaseNum) {
                          currentPhaseNum = phaseNum;
                          console.log(`[AutoMode] Phase ${phaseNum} completed for feature ${featureId}`);

                          this.emitAutoModeEvent("auto_mode_phase_complete", {
                            featureId,
                            projectPath,
                            phaseNumber: phaseNum,
                          });
                        }
                      }

                      this.emitAutoModeEvent("auto_mode_progress", {
                        featureId,
                        content: contBlock.text,
                      });
                    } else if (contBlock.type === "tool_use") {
                      this.emitAutoModeEvent("auto_mode_tool", {
                        featureId,
                        tool: contBlock.name,
                        input: contBlock.input,
                      });
                    }
                  }
                } else if (contMsg.type === "error") {
                  throw new Error(contMsg.error || "Unknown error during implementation");
                } else if (contMsg.type === "result" && contMsg.subtype === "success") {
                  responseText += contMsg.result || "";
                }
              }

              // Mark all tasks as completed when implementation finishes
              if (parsedTasks.length > 0) {
                await this.updateFeaturePlanSpec(projectPath, featureId, {
                  tasksCompleted: parsedTasks.length,
                });
              }

              console.log(`[AutoMode] Implementation completed for feature ${featureId} (${completedTaskIds.length}/${parsedTasks.length} tasks tracked)`);
              // Exit the original stream loop since continuation is done
              break streamLoop;
            }

            // Only emit progress for non-marker text (marker was already handled above)
            if (!specDetected) {
              this.emitAutoModeEvent("auto_mode_progress", {
                featureId,
                content: block.text,
              });
            }
          } else if (block.type === "tool_use") {
            this.emitAutoModeEvent("auto_mode_tool", {
              featureId,
              tool: block.name,
              input: block.input,
            });
          }
        }
      } else if (msg.type === "error") {
        // Handle error messages
        throw new Error(msg.error || "Unknown error");
      } else if (msg.type === "result" && msg.subtype === "success") {
        responseText = msg.result || responseText;
      }
    }

    // Save agent output
    try {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, responseText);
    } catch {
      // May fail if directory doesn't exist
    }
  }

  private async executeFeatureWithContext(
    projectPath: string,
    featureId: string,
    context: string,
    useWorktrees: boolean
  ): Promise<void> {
    const feature = await this.loadFeature(projectPath, featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const prompt = `## Continuing Feature Implementation

${this.buildFeaturePrompt(feature)}

## Previous Context
The following is the output from a previous implementation attempt. Continue from where you left off:

${context}

## Instructions
Review the previous work and continue the implementation. If the feature appears complete, verify it works correctly.`;

    return this.executeFeature(projectPath, featureId, useWorktrees, false, prompt);
  }

  /**
   * Emit an auto-mode event wrapped in the correct format for the client.
   * All auto-mode events are sent as type "auto-mode:event" with the actual
   * event type and data in the payload.
   */
  private emitAutoModeEvent(
    eventType: string,
    data: Record<string, unknown>
  ): void {
    // Wrap the event in auto-mode:event format expected by the client
    this.events.emit("auto-mode:event", {
      type: eventType,
      ...data,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
