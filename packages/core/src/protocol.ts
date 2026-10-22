import { z } from "zod";
import {
	AccountSnapshotSchema,
	AccountStatusSchema,
	BalanceSchema,
	EnvironmentSchema,
	FillSchema,
	InstrumentSchema,
	OrderSchema,
	PositionSchema,
	PriceUpdateSchema,
	VenueSchema,
} from "./domain.ts";

// docs/architecture.md §7. The server validates what it sends and the web app
// parses what it receives with these schemas.

export const AccountSummarySchema = z.strictObject({
	id: z.string(),
	label: z.string(),
	venue: VenueSchema,
	environment: EnvironmentSchema,
	status: AccountStatusSchema,
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

/** `GET /api/state`. */
export const StateSnapshotSchema = z.strictObject({
	accounts: z.array(AccountSummarySchema),
	/** Only the instruments the snapshots reference. */
	instruments: z.array(InstrumentSchema),
	snapshots: z.array(AccountSnapshotSchema),
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

/** WebSocket `/ws`, server → client. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
	// On connect and after every resync.
	z.strictObject({ type: z.literal("snapshot"), state: StateSnapshotSchema }),
	z.strictObject({ type: z.literal("balance"), balance: BalanceSchema }),
	z.strictObject({ type: z.literal("position"), position: PositionSchema }),
	z.strictObject({ type: z.literal("order"), order: OrderSchema }),
	z.strictObject({ type: z.literal("fill"), fill: FillSchema }),
	z.strictObject({ type: z.literal("price"), ...PriceUpdateSchema.shape }),
	z.strictObject({
		type: z.literal("account_status"),
		accountId: z.string(),
		status: AccountStatusSchema,
	}),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
