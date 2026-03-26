import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import type { TextValue } from "@notionhq/workers/types";

const worker = new Worker();
export default worker;

// ---------------------------------------------------------------------------
// Config & types
// ---------------------------------------------------------------------------

const YNAB_BASE_URL = "https://api.ynab.com/v1";

/** Maximum retry attempts for transient YNAB API failures. */
const MAX_RETRIES = 3;
/** Base delay in ms for exponential backoff (doubles each retry). */
const RETRY_BASE_DELAY_MS = 1000;

const requireEnv = (name: string): string => {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
};


/** YNAB monetary values are in milliunits (1000 = $1.00). */
const milliunitsToAmount = (milliunits: number): number =>
	Math.round(milliunits) / 1000;

const formatCurrency = (milliunits: number): string => {
	const amount = milliunitsToAmount(milliunits);
	return amount.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
};

// ---------------------------------------------------------------------------
// YNAB API types
// ---------------------------------------------------------------------------

type YnabAccount = {
	id: string;
	name: string;
	type: string;
	on_budget: boolean;
	closed: boolean;
	note: string | null;
	balance: number;
	cleared_balance: number;
	uncleared_balance: number;
	transfer_payee_id: string | null;
	direct_import_linked: boolean;
	direct_import_in_error: boolean;
	last_reconciled_at: string | null;
	deleted: boolean;
};

type YnabCategory = {
	id: string;
	category_group_id: string;
	category_group_name: string;
	name: string;
	hidden: boolean;
	note: string | null;
	budgeted: number;
	activity: number;
	balance: number;
	goal_type: string | null;
	goal_target: number | null;
	goal_target_month: string | null;
	goal_percentage_complete: number | null;
	goal_under_funded: number | null;
	deleted: boolean;
};

type YnabCategoryGroup = {
	id: string;
	name: string;
	hidden: boolean;
	deleted: boolean;
	categories: YnabCategory[];
};

type YnabTransaction = {
	id: string;
	date: string;
	amount: number;
	memo: string | null;
	cleared: string;
	approved: boolean;
	flag_color: string | null;
	flag_name: string | null;
	account_id: string;
	account_name: string;
	payee_id: string | null;
	payee_name: string | null;
	category_id: string | null;
	category_name: string | null;
	transfer_account_id: string | null;
	transfer_transaction_id: string | null;
	deleted: boolean;
	subtransactions: YnabSubTransaction[];
};

type YnabSubTransaction = {
	id: string;
	transaction_id: string;
	amount: number;
	memo: string | null;
	payee_id: string | null;
	payee_name: string | null;
	category_id: string | null;
	category_name: string | null;
	deleted: boolean;
};

type YnabPayee = {
	id: string;
	name: string;
	transfer_account_id: string | null;
	deleted: boolean;
};

type YnabMonthSummary = {
	month: string;
	income: number;
	budgeted: number;
	activity: number;
	to_be_budgeted: number;
	age_of_money: number | null;
	deleted: boolean;
};

// ---------------------------------------------------------------------------
// YNAB API client
// ---------------------------------------------------------------------------

async function ynabRequest<T>(path: string): Promise<T> {
	const token = requireEnv("YNAB_ACCESS_TOKEN");

	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}

		const response = await fetch(`${YNAB_BASE_URL}${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
		});

		if (response.ok) {
			const json = (await response.json()) as { data: T };
			return json.data;
		}

		// Don't retry client errors (4xx) other than 429 (rate limit)
		const isRetryable =
			response.status === 429 || response.status >= 500;

		// Sanitize: never include response body in errors (may contain sensitive data)
		lastError = new Error(
			`YNAB API error ${response.status} for ${path}`,
		);

		if (!isRetryable) break;
	}

	throw lastError ?? new Error(`YNAB API request failed for ${path}`);
}

function getBudgetId(): string {
	return requireEnv("YNAB_BUDGET_ID");
}

async function fetchAccounts(): Promise<YnabAccount[]> {
	const data = await ynabRequest<{ accounts: YnabAccount[] }>(
		`/budgets/${getBudgetId()}/accounts`,
	);
	return data.accounts.filter((a) => !a.deleted);
}

async function fetchCategoryGroups(): Promise<YnabCategoryGroup[]> {
	const data = await ynabRequest<{ category_groups: YnabCategoryGroup[] }>(
		`/budgets/${getBudgetId()}/categories`,
	);
	return data.category_groups.filter((g) => !g.deleted);
}

async function fetchCategories(): Promise<YnabCategory[]> {
	const groups = await fetchCategoryGroups();
	return groups.flatMap((g) => g.categories.filter((c) => !c.deleted));
}

async function fetchTransactions(): Promise<YnabTransaction[]> {
	const data = await ynabRequest<{ transactions: YnabTransaction[] }>(
		`/budgets/${getBudgetId()}/transactions`,
	);
	return data.transactions.filter((t) => !t.deleted);
}

async function fetchPayees(): Promise<YnabPayee[]> {
	const data = await ynabRequest<{ payees: YnabPayee[] }>(
		`/budgets/${getBudgetId()}/payees`,
	);
	return data.payees.filter((p) => !p.deleted);
}

async function fetchMonths(): Promise<YnabMonthSummary[]> {
	const data = await ynabRequest<{ months: YnabMonthSummary[] }>(
		`/budgets/${getBudgetId()}/months`,
	);
	return data.months.filter((m) => !m.deleted);
}

/** Validate and sanitize pagination state. */
function validatePaginationState(
	state: PaginationState | undefined,
): number {
	const offset = state?.offset ?? 0;
	if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
		return 0;
	}
	return offset;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const humanizeAccountType = (type: string): string => {
	const map: Record<string, string> = {
		checking: "Checking",
		savings: "Savings",
		cash: "Cash",
		creditCard: "Credit Card",
		lineOfCredit: "Line of Credit",
		otherAsset: "Other Asset",
		otherLiability: "Other Liability",
		mortgage: "Mortgage",
		autoLoan: "Auto Loan",
		studentLoan: "Student Loan",
		personalLoan: "Personal Loan",
		medicalDebt: "Medical Debt",
		otherDebt: "Other Debt",
	};
	return map[type] ?? type;
};

const humanizeClearedStatus = (status: string): string => {
	const map: Record<string, string> = {
		cleared: "Cleared",
		uncleared: "Uncleared",
		reconciled: "Reconciled",
	};
	return map[status] ?? status;
};

const humanizeGoalType = (type: string | null): string | null => {
	if (!type) return null;
	const map: Record<string, string> = {
		TB: "Target Balance",
		TBD: "Target Balance by Date",
		MF: "Monthly Funding",
		NEED: "Plan Your Spending",
		DEBT: "Debt",
	};
	return map[type] ?? type;
};

// Regex matching a leading emoji (including compound/ZWJ sequences and flag pairs).
const LEADING_EMOJI_RE =
	/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/u;

/**
 * Extract a leading emoji from a string, returning the emoji and the
 * remainder with leading whitespace trimmed.
 */
const extractLeadingEmoji = (
	text: string,
): { emoji: string; rest: string } | null => {
	const match = text.match(LEADING_EMOJI_RE);
	if (!match) return null;
	const emoji = match[0];
	const rest = text.slice(emoji.length).trimStart();
	// Only count it if there's actual text after the emoji
	if (!rest) return null;
	return { emoji, rest };
};

/** Map well-known payee names to emojis. */
const PAYEE_EMOJIS: Record<string, string> = {
	amazon: "📦",
	"amazon.com": "📦",
	apple: "🍎",
	spotify: "🎵",
	netflix: "🎬",
	hulu: "📺",
	"disney+": "🏰",
	uber: "🚗",
	lyft: "🚕",
	"uber eats": "🍔",
	doordash: "🛵",
	grubhub: "🍽️",
	starbucks: "☕",
	"chick-fil-a": "🐔",
	chipotle: "🌯",
	walmart: "🛒",
	target: "🎯",
	costco: "🏪",
	"whole foods": "🥑",
	trader: "🛍️",
	"trader joe": "🛍️",
	"trader joe's": "🛍️",
	venmo: "💸",
	paypal: "💳",
	"cash app": "💵",
	zelle: "💲",
	google: "🔍",
	microsoft: "💻",
	github: "🐙",
	steam: "🎮",
	twitch: "🟣",
	youtube: "▶️",
	"t-mobile": "📱",
	verizon: "📶",
	"at&t": "📞",
	comcast: "📡",
	xfinity: "📡",
	"state farm": "🛡️",
	geico: "🦎",
	progressive: "🛡️",
	chase: "🏦",
	"wells fargo": "🏦",
	"bank of america": "🏦",
	citi: "🏦",
	citibank: "🏦",
	"capital one": "🏦",
	discover: "💳",
	"american express": "💳",
	amex: "💳",
	stripe: "💳",
	shopify: "🛒",
	etsy: "🧶",
	airbnb: "🏠",
	"best buy": "🔌",
	"home depot": "🔨",
	"lowe's": "🔧",
	lowes: "🔧",
	ikea: "🪑",
	instacart: "🛒",
	kroger: "🛒",
	cvs: "💊",
	walgreens: "💊",
	"rite aid": "💊",
	mcdonald: "🍟",
	"mcdonald's": "🍟",
	"burger king": "🍔",
	wendy: "🍔",
	"wendy's": "🍔",
	"taco bell": "🌮",
	dunkin: "🍩",
	"dunkin'": "🍩",
	notion: "📝",
	slack: "💬",
	zoom: "📹",
	dropbox: "📂",
	adobe: "🎨",
	peloton: "🚴",
	gas: "⛽",
	shell: "⛽",
	exxon: "⛽",
	chevron: "⛽",
	bp: "⛽",
	parking: "🅿️",
	gym: "💪",
	dentist: "🦷",
	doctor: "🩺",
	hospital: "🏥",
	pharmacy: "💊",
	pet: "🐾",
	vet: "🐾",
};

/**
 * Try to find an emoji for a payee name.
 * Falls back to a transfer icon for transfer payees.
 */
const getPayeeEmoji = (payeeName: string): string | null => {
	const lower = payeeName.toLowerCase().trim();
	if (PAYEE_EMOJIS[lower]) return PAYEE_EMOJIS[lower];
	for (const [key, emoji] of Object.entries(PAYEE_EMOJIS)) {
		if (lower.startsWith(key)) return emoji;
	}
	return null;
};

// Smaller batches to stay under output size limits.
// Transactions have many properties + relations, so they need the smallest batch.
const PAYEE_PAGE_SIZE = 50;
const TXN_PAGE_SIZE = 20;

type PaginationState = { offset: number };

// ---------------------------------------------------------------------------
// Sync: Accounts
// ---------------------------------------------------------------------------

worker.sync("ynabAccountsSync", {
	primaryKeyProperty: "Account ID",
	mode: "replace",
	schedule: "1d",
	schema: {
		defaultName: "YNAB Accounts",
		databaseIcon: Builder.notionIcon("credit-card"),
		properties: {
			Account: Schema.title(),
			"Account ID": Schema.richText(),
			Type: Schema.select([
				{ name: "Checking" },
				{ name: "Savings" },
				{ name: "Cash" },
				{ name: "Credit Card" },
				{ name: "Line of Credit" },
				{ name: "Other Asset" },
				{ name: "Other Liability" },
				{ name: "Mortgage" },
				{ name: "Auto Loan" },
				{ name: "Student Loan" },
				{ name: "Personal Loan" },
				{ name: "Medical Debt" },
				{ name: "Other Debt" },
			]),
			"On Budget": Schema.checkbox(),
			Closed: Schema.checkbox(),
			Balance: Schema.number("dollar"),
			"Cleared Balance": Schema.number("dollar"),
			"Uncleared Balance": Schema.number("dollar"),
			Note: Schema.richText(),
			"Last Reconciled": Schema.date(),
		},
	},
	execute: async () => {
		const accounts = await fetchAccounts();

		const changes = accounts.map((account) => {
			const props: Record<string, TextValue> = {
				Account: Builder.title(account.name),
				"Account ID": Builder.richText(account.id),
				Type: Builder.select(humanizeAccountType(account.type)),
				"On Budget": Builder.checkbox(account.on_budget),
				Closed: Builder.checkbox(account.closed),
				Balance: Builder.number(milliunitsToAmount(account.balance)),
				"Cleared Balance": Builder.number(
					milliunitsToAmount(account.cleared_balance),
				),
				"Uncleared Balance": Builder.number(
					milliunitsToAmount(account.uncleared_balance),
				),
			};

			if (account.note) {
				props.Note = Builder.richText(account.note);
			}
			if (account.last_reconciled_at) {
				props["Last Reconciled"] = Builder.dateTime(
					account.last_reconciled_at,
				);
			}

			return {
				type: "upsert" as const,
				key: account.id,
				properties: {
					"Account ID": props["Account ID"],
					...props,
				},
				icon: account.closed
					? Builder.emojiIcon("🔒")
					: Builder.emojiIcon("🏦"),
			};
		});

		return { changes, hasMore: false };
	},
});

// ---------------------------------------------------------------------------
// Sync: Category Groups
// ---------------------------------------------------------------------------

worker.sync("ynabCategoryGroupsSync", {
	primaryKeyProperty: "Group ID",
	mode: "replace",
	schedule: "1d",
	schema: {
		defaultName: "YNAB Category Groups",
		databaseIcon: Builder.notionIcon("categories"),
		properties: {
			Group: Schema.title(),
			"Group ID": Schema.richText(),
			Hidden: Schema.checkbox(),
		},
	},
	execute: async () => {
		const groups = await fetchCategoryGroups();

		const changes = groups.map((group) => {
			const emojiResult = extractLeadingEmoji(group.name);
			return {
				type: "upsert" as const,
				key: group.id,
				properties: {
					"Group ID": Builder.richText(group.id),
					Group: Builder.title(emojiResult ? emojiResult.rest : group.name),
					Hidden: Builder.checkbox(group.hidden),
				},
				...(emojiResult
					? { icon: Builder.emojiIcon(emojiResult.emoji) }
					: {}),
			};
		});

		return { changes, hasMore: false };
	},
});

// ---------------------------------------------------------------------------
// Sync: Categories (with relation to Category Groups)
// ---------------------------------------------------------------------------

worker.sync("ynabCategoriesSync", {
	primaryKeyProperty: "Category ID",
	mode: "replace",
	schedule: "1d",
	schema: {
		defaultName: "YNAB Categories",
		databaseIcon: Builder.notionIcon("tag"),
		properties: {
			Category: Schema.title(),
			"Category ID": Schema.richText(),
			"Category Group": Schema.relation("ynabCategoryGroupsSync", {
				twoWay: true,
				relatedPropertyName: "Categories",
			}),
			"Group Name": Schema.richText(),
			Hidden: Schema.checkbox(),
			Budgeted: Schema.number("dollar"),
			Activity: Schema.number("dollar"),
			Balance: Schema.number("dollar"),
			"Goal Type": Schema.select([
				{ name: "Target Balance" },
				{ name: "Target Balance by Date" },
				{ name: "Monthly Funding" },
				{ name: "Plan Your Spending" },
				{ name: "Debt" },
			]),
			"Goal Target": Schema.number("dollar"),
			"Goal Target Month": Schema.date(),
			"Goal % Complete": Schema.number("percent"),
			"Goal Underfunded": Schema.number("dollar"),
			Note: Schema.richText(),
		},
	},
	execute: async () => {
		const categories = await fetchCategories();

		const changes = categories.map((cat) => {
			const props: Record<string, TextValue> = {
				Category: Builder.title(cat.name),
				"Category ID": Builder.richText(cat.id),
				"Group Name": Builder.richText(cat.category_group_name),
				Hidden: Builder.checkbox(cat.hidden),
				Budgeted: Builder.number(milliunitsToAmount(cat.budgeted)),
				Activity: Builder.number(milliunitsToAmount(cat.activity)),
				Balance: Builder.number(milliunitsToAmount(cat.balance)),
			};

			const goalType = humanizeGoalType(cat.goal_type);
			if (goalType) {
				props["Goal Type"] = Builder.select(goalType);
			}
			if (cat.goal_target != null) {
				props["Goal Target"] = Builder.number(
					milliunitsToAmount(cat.goal_target),
				);
			}
			if (cat.goal_target_month) {
				props["Goal Target Month"] = Builder.date(cat.goal_target_month);
			}
			if (cat.goal_percentage_complete != null) {
				props["Goal % Complete"] = Builder.number(
					cat.goal_percentage_complete / 100,
				);
			}
			if (cat.goal_under_funded != null) {
				props["Goal Underfunded"] = Builder.number(
					milliunitsToAmount(cat.goal_under_funded),
				);
			}
			if (cat.note) {
				props.Note = Builder.richText(cat.note);
			}

			const emojiResult = extractLeadingEmoji(cat.name);

			return {
				type: "upsert" as const,
				key: cat.id,
				properties: {
					"Category ID": props["Category ID"],
					...props,
					"Category Group": [Builder.relation(cat.category_group_id)],
				},
				...(emojiResult
					? { icon: Builder.emojiIcon(emojiResult.emoji) }
					: {}),
			};
		});

		return { changes, hasMore: false };
	},
});

// ---------------------------------------------------------------------------
// Sync: Payees (paginated — batches of 50)
// ---------------------------------------------------------------------------

worker.sync("ynabPayeesSync", {
	primaryKeyProperty: "Payee ID",
	mode: "replace",
	schedule: "1d",
	schema: {
		defaultName: "YNAB Payees",
		databaseIcon: Builder.notionIcon("shop"),
		properties: {
			Payee: Schema.title(),
			"Payee ID": Schema.richText(),
			"Is Transfer": Schema.checkbox(),
		},
	},
	execute: async (state: PaginationState | undefined) => {
		const offset = validatePaginationState(state);
		const allPayees = await fetchPayees();

		const batch = allPayees.slice(offset, offset + PAYEE_PAGE_SIZE);
		const hasMore = offset + PAYEE_PAGE_SIZE < allPayees.length;

		const changes = batch.map((payee) => {
			const isTransfer = payee.transfer_account_id != null;
			const emoji = isTransfer ? "🔄" : getPayeeEmoji(payee.name);
			return {
				type: "upsert" as const,
				key: payee.id,
				properties: {
					"Payee ID": Builder.richText(payee.id),
					Payee: Builder.title(payee.name),
					"Is Transfer": Builder.checkbox(isTransfer),
				},
				...(emoji ? { icon: Builder.emojiIcon(emoji) } : {}),
			};
		});

		return {
			changes,
			hasMore,
			nextState: hasMore ? { offset: offset + PAYEE_PAGE_SIZE } : undefined,
		};
	},
});

// ---------------------------------------------------------------------------
// Sync: Transactions (paginated — batches of 20)
// ---------------------------------------------------------------------------

worker.sync("ynabTransactionsSync", {
	primaryKeyProperty: "Transaction ID",
	mode: "replace",
	schedule: "1d",
	schema: {
		defaultName: "YNAB Transactions",
		databaseIcon: Builder.notionIcon("receipt"),
		properties: {
			Transaction: Schema.title(),
			"Transaction ID": Schema.richText(),
			Date: Schema.date(),
			Amount: Schema.number("dollar"),
			Memo: Schema.richText(),
			Cleared: Schema.select([
				{ name: "Cleared", color: "green" },
				{ name: "Uncleared", color: "yellow" },
				{ name: "Reconciled", color: "blue" },
			]),
			Approved: Schema.checkbox(),
			"Flag Color": Schema.select([
				{ name: "Red", color: "red" },
				{ name: "Orange", color: "orange" },
				{ name: "Yellow", color: "yellow" },
				{ name: "Green", color: "green" },
				{ name: "Blue", color: "blue" },
				{ name: "Purple", color: "purple" },
			]),
			Account: Schema.relation("ynabAccountsSync", {
				twoWay: true,
				relatedPropertyName: "Transactions",
			}),
			Payee: Schema.relation("ynabPayeesSync", {
				twoWay: true,
				relatedPropertyName: "Transactions",
			}),
			Category: Schema.relation("ynabCategoriesSync", {
				twoWay: true,
				relatedPropertyName: "Transactions",
			}),
			"Account Name": Schema.richText(),
			"Payee Name": Schema.richText(),
			"Category Name": Schema.richText(),
			"Is Transfer": Schema.checkbox(),
			"Is Split": Schema.checkbox(),
		},
	},
	execute: async (state: PaginationState | undefined) => {
		const offset = validatePaginationState(state);

		// YNAB returns all transactions in one call (no server-side pagination).
		// We paginate locally in small batches to stay under output size limits.
		const allTransactions = await fetchTransactions();

		const batch = allTransactions.slice(offset, offset + TXN_PAGE_SIZE);
		const hasMore = offset + TXN_PAGE_SIZE < allTransactions.length;

		const changes = batch.map((txn) => {
			const amount = milliunitsToAmount(txn.amount);
			const isInflow = txn.amount >= 0;
			const displayName =
				txn.payee_name ?? (isInflow ? "Inflow" : "Transaction");
			const displayAmount = formatCurrency(txn.amount);
			const titleText = `${displayName} · ${isInflow ? "+" : ""}$${displayAmount}`;

			const props: Record<string, TextValue> = {
				Transaction: Builder.title(titleText),
				"Transaction ID": Builder.richText(txn.id),
				Date: Builder.date(txn.date),
				Amount: Builder.number(amount),
				Cleared: Builder.select(humanizeClearedStatus(txn.cleared)),
				Approved: Builder.checkbox(txn.approved),
				"Account Name": Builder.richText(txn.account_name),
				"Is Transfer": Builder.checkbox(txn.transfer_account_id != null),
				"Is Split": Builder.checkbox(txn.subtransactions.length > 0),
			};

			if (txn.memo) {
				props.Memo = Builder.richText(txn.memo);
			}
			if (txn.flag_color) {
				const flagName =
					txn.flag_color.charAt(0).toUpperCase() + txn.flag_color.slice(1);
				props["Flag Color"] = Builder.select(flagName);
			}
			if (txn.payee_name) {
				props["Payee Name"] = Builder.richText(txn.payee_name);
			}
			if (txn.category_name) {
				props["Category Name"] = Builder.richText(txn.category_name);
			}

			return {
				type: "upsert" as const,
				key: txn.id,
				properties: {
					"Transaction ID": props["Transaction ID"],
					...props,
					Account: [Builder.relation(txn.account_id)],
					...(txn.payee_id ? { Payee: [Builder.relation(txn.payee_id)] } : {}),
					...(txn.category_id ? { Category: [Builder.relation(txn.category_id)] } : {}),
				},
				icon: isInflow
					? Builder.emojiIcon("💰")
					: Builder.emojiIcon("💸"),
			};
		});

		return {
			changes,
			hasMore,
			nextState: hasMore ? { offset: offset + TXN_PAGE_SIZE } : undefined,
		};
	},
});

// ---------------------------------------------------------------------------
// Sync: Monthly Budgets
// ---------------------------------------------------------------------------

worker.sync("ynabMonthsSync", {
	primaryKeyProperty: "Month",
	mode: "replace",
	schedule: "1d",
	schema: {
		defaultName: "YNAB Monthly Budgets",
		databaseIcon: Builder.notionIcon("calendar"),
		properties: {
			"Month Name": Schema.title(),
			Month: Schema.richText(),
			"Month Date": Schema.date(),
			Income: Schema.number("dollar"),
			Budgeted: Schema.number("dollar"),
			Activity: Schema.number("dollar"),
			"To Be Budgeted": Schema.number("dollar"),
			"Age of Money": Schema.number(),
		},
	},
	execute: async () => {
		const months = await fetchMonths();

		const changes = months.map((month) => {
			const date = new Date(month.month + "T00:00:00");
			const monthName = date.toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
			});

			const props: Record<string, TextValue> = {
				"Month Name": Builder.title(monthName),
				Month: Builder.richText(month.month),
				"Month Date": Builder.date(month.month),
				Income: Builder.number(milliunitsToAmount(month.income)),
				Budgeted: Builder.number(milliunitsToAmount(month.budgeted)),
				Activity: Builder.number(milliunitsToAmount(month.activity)),
				"To Be Budgeted": Builder.number(
					milliunitsToAmount(month.to_be_budgeted),
				),
			};

			if (month.age_of_money != null) {
				props["Age of Money"] = Builder.number(month.age_of_money);
			}

			return {
				type: "upsert" as const,
				key: month.month,
				properties: {
					Month: props.Month,
					...props,
				},
			};
		});

		return { changes, hasMore: false };
	},
});

// ---------------------------------------------------------------------------
// Sync: Audit Log (separate Notion DB for security audit trail)
// ---------------------------------------------------------------------------

/** Endpoints probed by the audit log sync. */
const AUDIT_ENDPOINTS = [
	{ syncName: "ynabAccountsSync", path: () => `/budgets/${getBudgetId()}/accounts`, countKey: "accounts" },
	{ syncName: "ynabCategoryGroupsSync", path: () => `/budgets/${getBudgetId()}/categories`, countKey: "category_groups" },
	{ syncName: "ynabPayeesSync", path: () => `/budgets/${getBudgetId()}/payees`, countKey: "payees" },
	{ syncName: "ynabTransactionsSync", path: () => `/budgets/${getBudgetId()}/transactions`, countKey: "transactions" },
	{ syncName: "ynabMonthsSync", path: () => `/budgets/${getBudgetId()}/months`, countKey: "months" },
] as const;

worker.sync("ynabAuditLogSync", {
	primaryKeyProperty: "Entry ID",
	mode: "incremental",
	schedule: "1d",
	schema: {
		defaultName: "YNAB Sync Audit Log",
		databaseIcon: Builder.emojiIcon("🔒"),
		properties: {
			Event: Schema.title(),
			"Entry ID": Schema.richText(),
			Timestamp: Schema.date(),
			"Sync Name": Schema.select([
				{ name: "ynabAccountsSync" },
				{ name: "ynabCategoryGroupsSync" },
				{ name: "ynabCategoriesSync" },
				{ name: "ynabPayeesSync" },
				{ name: "ynabTransactionsSync" },
				{ name: "ynabMonthsSync" },
			]),
			Status: Schema.select([
				{ name: "Success", color: "green" },
				{ name: "Error", color: "red" },
			]),
			"Record Count": Schema.number(),
			"Duration (ms)": Schema.number(),
			Endpoint: Schema.richText(),
			Error: Schema.richText(),
		},
	},
	execute: async () => {
		const now = new Date().toISOString();
		const changes = [];

		for (const ep of AUDIT_ENDPOINTS) {
			const endpoint = ep.path();
			const start = Date.now();
			let status: "success" | "error" = "success";
			let recordCount = 0;
			let errorMsg: string | undefined;

			try {
				const data = await ynabRequest<Record<string, unknown[]>>(endpoint);
				const items = data[ep.countKey];
				recordCount = Array.isArray(items) ? items.length : 0;
			} catch (err) {
				status = "error";
				errorMsg = err instanceof Error ? err.message : String(err);
			}

			const durationMs = Date.now() - start;
			const id = `${ep.syncName}-${now}`;
			const statusLabel = status === "success" ? "Success" : "Error";
			const title = `${statusLabel}: ${ep.syncName} (${recordCount} records)`;

			const props: Record<string, TextValue> = {
				Event: Builder.title(title),
				"Entry ID": Builder.richText(id),
				Timestamp: Builder.dateTime(now),
				"Sync Name": Builder.select(ep.syncName),
				Status: Builder.select(statusLabel),
				"Record Count": Builder.number(recordCount),
				"Duration (ms)": Builder.number(durationMs),
				Endpoint: Builder.richText(endpoint),
			};

			if (errorMsg) {
				props.Error = Builder.richText(errorMsg);
			}

			changes.push({
				type: "upsert" as const,
				key: id,
				properties: {
					"Entry ID": props["Entry ID"],
					...props,
				},
				icon:
					status === "success"
						? Builder.emojiIcon("✅")
						: Builder.emojiIcon("❌"),
			});
		}

		return { changes, hasMore: false };
	},
});
