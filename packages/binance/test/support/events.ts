// Doc-shaped user-data events (binance-spot-api-docs user-data-stream.md;
// USDⓈ-M futures user-data stream docs), every field present that the docs
// show, so a mapping test also proves extra fields are tolerated.

/** Spot `executionReport`: a NEW BTCUSDT limit buy unless overridden. */
export function executionReport(
	fields: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		e: "executionReport",
		E: 1_800_000_000_101,
		s: "BTCUSDT",
		c: "web_spot_1",
		S: "BUY",
		o: "LIMIT",
		f: "GTC",
		q: "0.00020000",
		p: "60000.00000000",
		P: "0.00000000",
		F: "0.00000000",
		g: -1,
		C: "",
		x: "NEW",
		X: "NEW",
		r: "NONE",
		i: 1001,
		l: "0.00000000",
		z: "0.00000000",
		L: "0.00000000",
		n: "0",
		N: null,
		T: 1_800_000_000_100,
		t: -1,
		I: 8641984,
		w: true,
		m: false,
		M: false,
		O: 1_800_000_000_100,
		Z: "0.00000000",
		Y: "0.00000000",
		Q: "0.00000000",
		W: 1_800_000_000_100,
		V: "EXPIRE_MAKER",
		...fields,
	};
}

export function outboundAccountPosition(
	B: Array<{ a: string; f: string; l: string }>,
	E = 1_800_000_000_201,
): Record<string, unknown> {
	return { e: "outboundAccountPosition", E, u: E - 1, B };
}

/** Futures `ORDER_TRADE_UPDATE`: a NEW BTCUSDT limit buy without commission unless overridden. */
export function orderTradeUpdate(
	o: Record<string, unknown> = {},
	E = 1_800_000_000_301,
): Record<string, unknown> {
	const order = {
		s: "BTCUSDT",
		c: "web_fut_1",
		S: "BUY",
		o: "LIMIT",
		f: "GTC",
		q: "0.002",
		p: "70000",
		ap: "0",
		sp: "0",
		x: "NEW",
		X: "NEW",
		i: 5001,
		l: "0",
		z: "0",
		L: "0",
		T: E - 1,
		t: 0,
		b: "140",
		a: "0",
		m: false,
		R: false,
		wt: "CONTRACT_PRICE",
		ot: "LIMIT",
		ps: "BOTH",
		cp: false,
		rp: "0",
		pP: false,
		si: 0,
		ss: 0,
		V: "EXPIRE_MAKER",
		pm: "NONE",
		gtd: 0,
		...o,
	};
	return { e: "ORDER_TRADE_UPDATE", E, T: order.T, o: order };
}

/** Futures `ALGO_UPDATE`: a NEW BTCUSDT take-profit-market sell unless overridden. */
export function algoUpdate(
	o: Record<string, unknown> = {},
	E = 1_800_000_000_401,
): Record<string, unknown> {
	return {
		e: "ALGO_UPDATE",
		T: E - 1,
		E,
		o: {
			caid: "web_algo_1",
			aid: 2148719,
			at: "CONDITIONAL",
			o: "TAKE_PROFIT_MARKET",
			s: "BTCUSDT",
			S: "SELL",
			ps: "BOTH",
			f: "GTC",
			q: "0.002",
			X: "NEW",
			ai: "",
			ap: "0.00000",
			aq: "0.00000",
			act: "0",
			tp: "90000",
			p: "0",
			V: "EXPIRE_MAKER",
			wt: "MARK_PRICE",
			pm: "NONE",
			cp: false,
			pP: false,
			R: true,
			tt: 0,
			gtd: 0,
			rm: "",
			...o,
		},
	};
}

/** Futures `ACCOUNT_UPDATE` naming the changed `assets` and position `symbols`. */
export function accountUpdate(
	change: { assets?: string[]; symbols?: string[] },
	E = 1_800_000_000_501,
): Record<string, unknown> {
	return {
		e: "ACCOUNT_UPDATE",
		E,
		T: E - 1,
		a: {
			m: "ORDER",
			B: (change.assets ?? []).map((a) => ({
				a,
				wb: "100.00000000",
				cw: "100.00000000",
				bc: "0",
			})),
			P: (change.symbols ?? []).map((s) => ({
				s,
				pa: "0.002",
				ep: "70000.0",
				bep: "70028",
				cr: "0",
				up: "0",
				mt: "cross",
				iw: "0",
				ps: "BOTH",
			})),
		},
	};
}

export function leverageUpdate(
	symbol: string,
	l: number,
	E = 1_800_000_000_601,
): Record<string, unknown> {
	return { e: "ACCOUNT_CONFIG_UPDATE", E, T: E - 1, ac: { s: symbol, l } };
}
