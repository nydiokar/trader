/**
 * Jupiter Swap API v1 / Metis error reference.
 *
 * Scope:
 * - quoteGet + swapPost against https://api.jup.ag/swap/v1/
 * - V0/versioned transactions
 * - wrapAndUnwrapSol=true
 * - restrictIntermediateTokens=true
 * - dynamicComputeUnitLimit=true
 *
 * Important:
 * - Custom simulation codes MUST be decoded with the failing program id.
 *   Numeric code alone is unsafe: 6001 means different things in Jupiter vs Orca vs Raydium.
 * - Use Jupiter /program-id-to-label to identify unknown DEX program ids in production logs.
 * - DEX custom code tables below are sourced from each program's on-chain IDL / source as of 2025.
 *   Verify against actual program source if you add a new DEX.
 */

export type RecoveryAction =
  | "none"
  | "retry_same_quote"
  | "refresh_quote"
  | "raise_slippage_and_refresh_quote"
  | "reduce_amount_and_refresh_quote"
  | "top_up_sol_or_reduce_amount"
  | "fix_request_params"
  | "exclude_dex_and_refresh_quote"
  | "abort_not_retryable"
  | "unknown_decode_logs";

// ---------------------------------------------------------------------------
// Layer 1: Jupiter HTTP API errors (quote / swap POST response body errorCode)
// ---------------------------------------------------------------------------

export type KnownApiError = {
  layer: "jupiter-http";
  meaning: string;
  retryable: boolean;
  slippageHelps: boolean;
  recovery: RecoveryAction;
};

export const JUPITER_V1_HTTP_ERROR_CODES: Record<string, KnownApiError> = {
  // --- Quote / routing errors ---

  NO_ROUTES_FOUND: {
    layer: "jupiter-http",
    meaning: "No route exists for this input/output pair, amount, or current liquidity state.",
    retryable: false,
    slippageHelps: false,
    recovery: "abort_not_retryable",
  },

  COULD_NOT_FIND_ANY_ROUTE: {
    layer: "jupiter-http",
    meaning: "Jupiter found no valid executable route.",
    retryable: false,
    slippageHelps: false,
    recovery: "abort_not_retryable",
  },

  ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT: {
    layer: "jupiter-http",
    meaning: "Route exists but cannot consume the full requested input amount.",
    retryable: true,
    slippageHelps: false,
    recovery: "reduce_amount_and_refresh_quote",
  },

  MARKET_NOT_FOUND: {
    layer: "jupiter-http",
    meaning: "Referenced market/pool address is not found or not active in Jupiter routing data.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  TOKEN_NOT_TRADABLE: {
    layer: "jupiter-http",
    meaning: "Token mint is not available for trading through Jupiter.",
    retryable: false,
    slippageHelps: false,
    recovery: "abort_not_retryable",
  },

  NOT_SUPPORTED: {
    layer: "jupiter-http",
    meaning: "Unsupported operation or unsupported route/request combination.",
    retryable: false,
    slippageHelps: false,
    recovery: "fix_request_params",
  },

  CIRCULAR_ARBITRAGE_IS_DISABLED: {
    layer: "jupiter-http",
    meaning: "Input and output mint are the same; Jupiter does not allow circular swaps.",
    retryable: false,
    slippageHelps: false,
    recovery: "fix_request_params",
  },

  CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD: {
    layer: "jupiter-http",
    meaning: "Jupiter could not compute minOut/maxIn threshold from amount and slippage.",
    retryable: true,
    slippageHelps: true,
    recovery: "raise_slippage_and_refresh_quote",
  },

  // --- swapPost / transaction-composition errors ---

  MAX_ACCOUNT_GREATER_THAN_MAX: {
    layer: "jupiter-http",
    meaning: "Requested route/transaction exceeds maximum account limit.",
    retryable: true,
    slippageHelps: false,
    recovery: "fix_request_params",
  },

  INVALID_COMPUTE_UNIT_PRICE_AND_PRIORITIZATION_FEE: {
    layer: "jupiter-http",
    meaning: "Both computeUnitPriceMicroLamports and prioritizationFeeLamports were supplied; use only one.",
    retryable: false,
    slippageHelps: false,
    recovery: "fix_request_params",
  },

  FAILED_TO_GET_SWAP_AND_ACCOUNT_METAS: {
    layer: "jupiter-http",
    meaning: "Jupiter failed to generate swap transaction/account metas.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },
};

// Codes that map to no_route in normalizeJupiterError — terminal, don't retry.
export const NO_ROUTE_HTTP_CODES = new Set([
  "NO_ROUTES_FOUND",
  "COULD_NOT_FIND_ANY_ROUTE",
  "TOKEN_NOT_TRADABLE",
]);

// ---------------------------------------------------------------------------
// Layer 2: Simulation InstructionError Custom codes (keyed by programId:code)
// ---------------------------------------------------------------------------

export type KnownSimulationError = {
  layer: "simulation-custom";
  program: string;
  name: string;
  meaning: string;
  retryable: boolean;
  slippageHelps: boolean;
  recovery: RecoveryAction;
};

export const PROGRAM_IDS = {
  JUPITER_SWAP:       "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  SPL_TOKEN:          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  SPL_TOKEN_2022:     "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ASSOCIATED_TOKEN:   "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  RAYDIUM_AMM_V4:     "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  RAYDIUM_CPMM:       "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  RAYDIUM_CLMM:       "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  ORCA_WHIRLPOOL:     "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  METEORA_DLMM:       "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  METEORA_DYNAMIC_AMM:"Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
} as const;

const k = (programId: string, code: number) => `${programId}:${code}`;

const sim = (
  program: string,
  name: string,
  meaning: string,
  retryable: boolean,
  slippageHelps: boolean,
  recovery: RecoveryAction,
): KnownSimulationError => ({ layer: "simulation-custom", program, name, meaning, retryable, slippageHelps, recovery });

export const KNOWN_SIMULATION_CUSTOM_ERRORS: Record<string, KnownSimulationError> = {

  // -------------------------------------------------------------------------
  // Jupiter Swap Program (JUP6Lk...)
  // Anchor 6000-based enum. Officially documented: 6001, 6008, 6014, 6017, 6024, 6025.
  // -------------------------------------------------------------------------

  [k(PROGRAM_IDS.JUPITER_SWAP, 6001)]: sim(
    "Jupiter Swap", "SlippageToleranceExceeded",
    "Jupiter swap output fell below the quoted slippage threshold.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.JUPITER_SWAP, 6008)]: sim(
    "Jupiter Swap", "NotEnoughAccountKeys",
    "Transaction account metas missing or transaction was modified after Jupiter built it.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.JUPITER_SWAP, 6014)]: sim(
    "Jupiter Swap", "IncorrectTokenProgramID",
    "Wrong SPL Token vs Token-2022 program for one of the mints/accounts.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.JUPITER_SWAP, 6017)]: sim(
    "Jupiter Swap", "ExactOutAmountNotMatched",
    "Exact-out swap could not produce the requested output amount.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.JUPITER_SWAP, 6024)]: sim(
    "Jupiter Swap", "InsufficientFunds",
    "User lacks input tokens, SOL for fees, SOL rent, or wrapped SOL buffer. Token account may be empty.",
    false, false, "top_up_sol_or_reduce_amount",
  ),

  [k(PROGRAM_IDS.JUPITER_SWAP, 6025)]: sim(
    "Jupiter Swap", "InvalidTokenAccount",
    "Invalid, uninitialized, or unexpected token account in route.",
    true, false, "refresh_quote",
  ),

  // -------------------------------------------------------------------------
  // SPL Token Program (classic, Tokenkeg...)
  // Not Anchor — codes are raw enum ordinals from the spl-token source.
  // Relevant subset for swap context.
  // -------------------------------------------------------------------------

  [k(PROGRAM_IDS.SPL_TOKEN, 1)]: sim(
    "SPL Token", "InsufficientFunds",
    "Token account balance is lower than the requested transfer/burn amount.",
    false, false, "top_up_sol_or_reduce_amount",
  ),

  [k(PROGRAM_IDS.SPL_TOKEN, 4)]: sim(
    "SPL Token", "OwnerMismatch",
    "Token account owner does not match the expected owner.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.SPL_TOKEN, 9)]: sim(
    "SPL Token", "InvalidState",
    "Token account is frozen or in an invalid state for this operation.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.SPL_TOKEN, 17)]: sim(
    "SPL Token", "InvalidAccountData",
    "Token account data is invalid or does not match expected layout.",
    true, false, "refresh_quote",
  ),

  [k(PROGRAM_IDS.SPL_TOKEN_2022, 1)]: sim(
    "SPL Token-2022", "InsufficientFunds",
    "Token-2022 account balance is lower than the requested amount.",
    false, false, "top_up_sol_or_reduce_amount",
  ),

  [k(PROGRAM_IDS.SPL_TOKEN_2022, 4)]: sim(
    "SPL Token-2022", "OwnerMismatch",
    "Token-2022 account owner mismatch.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.SPL_TOKEN_2022, 9)]: sim(
    "SPL Token-2022", "InvalidState",
    "Token-2022 account is frozen or in an invalid state.",
    false, false, "abort_not_retryable",
  ),

  // -------------------------------------------------------------------------
  // Raydium AMM v4 (675kPX...)
  // NOT Anchor — raw u32 error enum ordinals, not 6000-based.
  // -------------------------------------------------------------------------

  [k(PROGRAM_IDS.RAYDIUM_AMM_V4, 30)]: sim(
    "Raydium AMM v4", "InvalidStatus",
    "Pool is in an invalid status for swapping (e.g. not yet initialized or disabled).",
    true, false, "refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_AMM_V4, 36)]: sim(
    "Raydium AMM v4", "ExceededSlippage",
    "Swap output fell below the slippage limit set by the route.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_AMM_V4, 38)]: sim(
    "Raydium AMM v4", "InvalidInput",
    "Swap input amount is zero or invalid.",
    false, false, "abort_not_retryable",
  ),

  // -------------------------------------------------------------------------
  // Raydium CPMM (CPMMoo...)
  // Anchor 6000-based.
  // -------------------------------------------------------------------------

  [k(PROGRAM_IDS.RAYDIUM_CPMM, 6000)]: sim(
    "Raydium CPMM", "NotApproved",
    "Swap not approved — pool may be paused.",
    true, false, "refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_CPMM, 6001)]: sim(
    "Raydium CPMM", "InvalidInput",
    "Swap input amount is zero or otherwise invalid.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.RAYDIUM_CPMM, 6002)]: sim(
    "Raydium CPMM", "ExceededDesiredAmount",
    "Exact-in swap: output less than desired; exact-out swap: input more than desired.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_CPMM, 6005)]: sim(
    "Raydium CPMM", "ExceededSlippage",
    "Swap output fell below the slippage threshold.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_CPMM, 6011)]: sim(
    "Raydium CPMM", "NotEnoughLiquidity",
    "Pool does not have enough liquidity for this swap size.",
    true, false, "reduce_amount_and_refresh_quote",
  ),

  // -------------------------------------------------------------------------
  // Raydium CLMM (CAMMCz...)
  // Anchor 6000-based.
  // -------------------------------------------------------------------------

  [k(PROGRAM_IDS.RAYDIUM_CLMM, 6001)]: sim(
    "Raydium CLMM", "NotApproved",
    "Pool is paused or not approved for swapping.",
    true, false, "refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_CLMM, 6011)]: sim(
    "Raydium CLMM", "InvaildTickArray",
    "Tick array account missing or invalid for current price range.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_CLMM, 6017)]: sim(
    "Raydium CLMM", "TooLittleOutputReceived",
    "Exact-in slippage check: output below minAmountOut.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_CLMM, 6018)]: sim(
    "Raydium CLMM", "TooMuchInputPaid",
    "Exact-out slippage check: input above maxAmountIn.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.RAYDIUM_CLMM, 6019)]: sim(
    "Raydium CLMM", "PriceSlippageCheck",
    "Swap crossed price limit — price moved beyond sqrt price limit.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  // -------------------------------------------------------------------------
  // Orca Whirlpool (whirLb...)
  // Anchor 6000-based. Errors 6000–6069 from Whirlpool source.
  // -------------------------------------------------------------------------

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6000)]: sim(
    "Orca Whirlpool", "InvalidEnum",
    "Invalid enum value in instruction data.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6001)]: sim(
    "Orca Whirlpool", "InvalidStartTick",
    "Start tick index is not a valid tick spacing multiple.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6002)]: sim(
    "Orca Whirlpool", "TickArrayExistInPool",
    "Tick array already exists.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6003)]: sim(
    "Orca Whirlpool", "TickArrayIndexOutofBounds",
    "Tick array index out of bounds for current pool.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6004)]: sim(
    "Orca Whirlpool", "InvalidTickSpacing",
    "Invalid tick spacing for this pool.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6010)]: sim(
    "Orca Whirlpool", "DivideByZero",
    "Division by zero in price/liquidity computation — pool likely empty.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6014)]: sim(
    "Orca Whirlpool", "ZeroTradableAmount",
    "No tradable liquidity in the requested tick range.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6015)]: sim(
    "Orca Whirlpool", "AmountOutBelowMinimum",
    "Exact-in slippage: output below minimum threshold.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6016)]: sim(
    "Orca Whirlpool", "AmountInAboveMaximum",
    "Exact-out slippage: input above maximum threshold.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6017)]: sim(
    "Orca Whirlpool", "TickNotFound",
    "Required tick account not found or wrong tick array supplied.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6018)]: sim(
    "Orca Whirlpool", "InvalidTickArraySequence",
    "Tick arrays are not in the correct sequential order for this swap.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6019)]: sim(
    "Orca Whirlpool", "InvalidTokenMintOrder",
    "Token mints are not in canonical order for this pool.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6020)]: sim(
    "Orca Whirlpool", "RewardNotSupported",
    "Reward index not supported for this pool.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6033)]: sim(
    "Orca Whirlpool", "SqrtPriceOutOfBounds",
    "Computed sqrt price exceeded protocol bounds.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6038)]: sim(
    "Orca Whirlpool", "InvalidTimestamp",
    "Block timestamp outside expected range.",
    true, false, "retry_same_quote",
  ),

  [k(PROGRAM_IDS.ORCA_WHIRLPOOL, 6044)]: sim(
    "Orca Whirlpool", "PartialFillError",
    "Swap could only be partially filled.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  // -------------------------------------------------------------------------
  // Meteora DLMM (LBUZK...)
  // Anchor 6000-based.
  // -------------------------------------------------------------------------

  [k(PROGRAM_IDS.METEORA_DLMM, 6000)]: sim(
    "Meteora DLMM", "InvalidStartBinIndex",
    "Start bin index is invalid for this pool.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DLMM, 6001)]: sim(
    "Meteora DLMM", "InvalidBinId",
    "Bin ID is out of range for this pool.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DLMM, 6003)]: sim(
    "Meteora DLMM", "CompositionFactorFlawed",
    "Bin composition factor is invalid.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DLMM, 6006)]: sim(
    "Meteora DLMM", "ExceededAmountSlippageTolerance",
    "Swap amount exceeded allowed slippage tolerance.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DLMM, 6007)]: sim(
    "Meteora DLMM", "ExceededBinSlippageTolerance",
    "Swap crossed more bins than the bin slippage tolerance allows.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DLMM, 6009)]: sim(
    "Meteora DLMM", "InsufficientOutAmount",
    "Output amount is less than the minimum required.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DLMM, 6016)]: sim(
    "Meteora DLMM", "PairInsufficientLiquidity",
    "Pool does not have enough liquidity for this swap.",
    true, false, "reduce_amount_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DLMM, 6019)]: sim(
    "Meteora DLMM", "InvalidInput",
    "Swap input amount is zero or invalid.",
    false, false, "abort_not_retryable",
  ),

  // -------------------------------------------------------------------------
  // Meteora Dynamic AMM / DAMM v1 (Eo7WjK...)
  // Anchor 6000-based.
  // -------------------------------------------------------------------------

  [k(PROGRAM_IDS.METEORA_DYNAMIC_AMM, 6001)]: sim(
    "Meteora Dynamic AMM", "ExceededSlippage",
    "Swap output fell below slippage threshold.",
    true, true, "raise_slippage_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DYNAMIC_AMM, 6004)]: sim(
    "Meteora Dynamic AMM", "MathOverflow",
    "Arithmetic overflow in price/liquidity computation.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DYNAMIC_AMM, 6005)]: sim(
    "Meteora Dynamic AMM", "InvalidFee",
    "Fee configuration invalid for this pool.",
    false, false, "abort_not_retryable",
  ),

  [k(PROGRAM_IDS.METEORA_DYNAMIC_AMM, 6011)]: sim(
    "Meteora Dynamic AMM", "PoolDisabled",
    "Pool is disabled and not accepting swaps.",
    true, false, "exclude_dex_and_refresh_quote",
  ),

  [k(PROGRAM_IDS.METEORA_DYNAMIC_AMM, 6012)]: sim(
    "Meteora Dynamic AMM", "InsufficientLiquidity",
    "Pool does not have enough liquidity for this swap.",
    true, false, "reduce_amount_and_refresh_quote",
  ),
};

// ---------------------------------------------------------------------------
// Layer 3: Non-Custom simulation errors
// Top-level TransactionError strings and InstructionError string variants.
// These appear as plain strings, not {Custom: n}.
// ---------------------------------------------------------------------------

export type KnownNonCustomSimulationError = {
  layer: "simulation-non-custom";
  meaning: string;
  retryable: boolean;
  slippageHelps: boolean;
  recovery: RecoveryAction;
};

export const KNOWN_NON_CUSTOM_SIMULATION_ERRORS: Record<string, KnownNonCustomSimulationError> = {
  // --- TransactionError-level (top-level err string) ---

  InsufficientFundsForRent: {
    layer: "simulation-non-custom",
    meaning: "Transaction leaves an account below rent-exempt minimum. Common with wrapAndUnwrapSol or ATA creation.",
    retryable: false,
    slippageHelps: false,
    recovery: "top_up_sol_or_reduce_amount",
  },

  InsufficientFundsForFee: {
    layer: "simulation-non-custom",
    meaning: "Fee payer lacks SOL for transaction fee/priority fee.",
    retryable: false,
    slippageHelps: false,
    recovery: "top_up_sol_or_reduce_amount",
  },

  BlockhashNotFound: {
    layer: "simulation-non-custom",
    meaning: "Recent blockhash expired or not found. Should not happen with replaceRecentBlockhash=true.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  AlreadyProcessed: {
    layer: "simulation-non-custom",
    meaning: "Same transaction was already processed on-chain.",
    retryable: false,
    slippageHelps: false,
    recovery: "abort_not_retryable",
  },

  AccountInUse: {
    layer: "simulation-non-custom",
    meaning: "Account is locked by another in-flight transaction.",
    retryable: true,
    slippageHelps: false,
    recovery: "retry_same_quote",
  },

  TooManyAccountLocks: {
    layer: "simulation-non-custom",
    meaning: "Transaction locks too many accounts.",
    retryable: true,
    slippageHelps: false,
    recovery: "fix_request_params",
  },

  AddressLookupTableNotFound: {
    layer: "simulation-non-custom",
    meaning: "V0 transaction references an ALT that is missing or deactivated.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  InvalidAddressLookupTableOwner: {
    layer: "simulation-non-custom",
    meaning: "ALT account has wrong owner.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  InvalidAddressLookupTableData: {
    layer: "simulation-non-custom",
    meaning: "ALT account data invalid or stale.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  InvalidAddressLookupTableIndex: {
    layer: "simulation-non-custom",
    meaning: "V0 transaction references an invalid ALT index.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  MaxLoadedAccountsDataSizeExceeded: {
    layer: "simulation-non-custom",
    meaning: "Loaded account data exceeds per-transaction cap.",
    retryable: true,
    slippageHelps: false,
    recovery: "fix_request_params",
  },

  // --- InstructionError string variants ---

  InvalidAccountData: {
    layer: "simulation-non-custom",
    meaning: "Program expected a different account data layout. Usually a stale/wrong pool or ATA account.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  InvalidInstructionData: {
    layer: "simulation-non-custom",
    meaning: "Instruction data malformed or incompatible with current program version.",
    retryable: false,
    slippageHelps: false,
    recovery: "abort_not_retryable",
  },

  IncorrectProgramId: {
    layer: "simulation-non-custom",
    meaning: "Account is owned by a different program than expected.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  InvalidAccountOwner: {
    layer: "simulation-non-custom",
    meaning: "Account owner mismatch.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  UninitializedAccount: {
    layer: "simulation-non-custom",
    meaning: "Program expected an initialized account. Common in ATA or pool account races.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  AccountAlreadyInitialized: {
    layer: "simulation-non-custom",
    meaning: "Account initialization attempted but account already exists.",
    retryable: true,
    slippageHelps: false,
    recovery: "refresh_quote",
  },

  MissingRequiredSignature: {
    layer: "simulation-non-custom",
    meaning: "Required signer is missing.",
    retryable: false,
    slippageHelps: false,
    recovery: "abort_not_retryable",
  },

  AccountNotRentExempt: {
    layer: "simulation-non-custom",
    meaning: "Instruction-created account is not rent-exempt.",
    retryable: false,
    slippageHelps: false,
    recovery: "top_up_sol_or_reduce_amount",
  },

  ComputationalBudgetExceeded: {
    layer: "simulation-non-custom",
    meaning: "Route exceeded compute budget despite dynamicComputeUnitLimit=true.",
    retryable: true,
    slippageHelps: false,
    recovery: "exclude_dex_and_refresh_quote",
  },

  ProgramFailedToComplete: {
    layer: "simulation-non-custom",
    meaning: "Program aborted or exceeded internal execution constraints.",
    retryable: true,
    slippageHelps: false,
    recovery: "exclude_dex_and_refresh_quote",
  },

  ProgramFailedToCompile: {
    layer: "simulation-non-custom",
    meaning: "Program execution/loader failure.",
    retryable: false,
    slippageHelps: false,
    recovery: "abort_not_retryable",
  },
};
