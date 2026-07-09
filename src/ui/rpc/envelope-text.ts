/**
 * quick-studio UI (Ring 2) — shared RPC error formatter.
 *
 * The single place an {@link RpcErrorEnvelope} becomes a terse mono one-liner for
 * in-panel display. Shared so every panel renders errors identically.
 */

import type { RpcErrorEnvelope } from "../../shared/contract.ts";

/** Terse mono description of an RPC error envelope, surfaced in-panel. */
export function envelopeText(error: RpcErrorEnvelope): string {
  return error.detail ? `${error.code}: ${error.message} (${error.detail})` : `${error.code}: ${error.message}`;
}
