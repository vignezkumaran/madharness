// ─── AST Pruner Types ───────────────────────────────────────────────────────

/** The result of pruning a Python source file to its interface contract */
export interface InterfaceContract {
  /** Path to the original source file */
  originalPath: string;
  /** Number of lines in the original file */
  originalLines: number;
  /** Number of lines after pruning */
  prunedLines: number;
  /** The pruned source content (signatures only) */
  prunedContent: string;
  /** Percentage of tokens saved by pruning */
  tokenSavingsPercent: number;
  /** Class names discovered in the file */
  classes: string[];
  /** Function names discovered in the file */
  functions: string[];
  /** Import statements found in the file */
  imports: string[];
}

/** Options to control AST pruning behavior */
export interface PrunerOptions {
  /** Keep docstrings in the pruned output (default: false) */
  keepDocstrings?: boolean;
  /** Keep comments in the pruned output (default: false) */
  keepComments?: boolean;
  /** Keep module-level constants/assignments (default: true) */
  keepConstants?: boolean;
  /** Maximum nesting depth to extract (default: unlimited) */
  maxDepth?: number;
}
