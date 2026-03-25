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
	const response = await fetch(`${YNAB_BASE_URL}${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(
			`YNAB API request failed (${response.status}) for ${path}: ${details}`,
		);
	}

	const json = (await response.json()) as { data: T };
	return json.data;
}

function getBudgetId(): string {
	return process.env.YNAB_BUDGET_ID ?? "last-used";
}

async function fetchAccounts(): Promise<YnabAccount[]> {
	const data = await ynabRequest<{ accounts: YnabAccount[] }>(
		`/budgets/${getBudgetId()}/accounts`,
	);
	return data.accounts.filter((a) => !a.deleted);
}

async function fetchCategories(): Promise<YnabCategory[]> {
	const data = await ynabRequest<{ category_groups: YnabCategoryGroup[] }>(
		`/budgets/${getBudgetId()}/categories`,
	);
	return data.category_groups
		.filter((g) => !g.deleted)
		.flatMap((g) => g.categories.filter((c) => !c.deleted));
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

const PAGE_SIZE = 100;

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
			Balance: Schema.number(),
			"Cleared Balance": Schema.number(),
			"Uncleared Balance": Schema.number(),
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
// Sync: Categories
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
			Group: Schema.richText(),
			Hidden: Schema.checkbox(),
			Budgeted: Schema.number(),
			Activity: Schema.number(),
			Balance: Schema.number(),
			"Goal Type": Schema.select([
				{ name: "Target Balance" },
				{ name: "Target Balance by Date" },
				{ name: "Monthly Funding" },
				{ name: "Plan Your Spending" },
				{ name: "Debt" },
			]),
			"Goal Target": Schema.number(),
			"Goal Target Month": Schema.date(),
			"Goal % Complete": Schema.number("percent"),
			"Goal Underfunded": Schema.number(),
			Note: Schema.richText(),
		},
	},
	execute: async () => {
		const categories = await fetchCategories();

		const changes = categories.map((cat) => {
			const props: Record<string, TextValue> = {
				Category: Builder.title(cat.name),
				"Category ID": Builder.richText(cat.id),
				Group: Builder.richText(cat.category_group_name),
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

			return {
				type: "upsert" as const,
				key: cat.id,
				properties: {
					"Category ID": props["Category ID"],
					...props,
				},
			};
		});

		return { changes, hasMore: false };
	},
});

// ---------------------------------------------------------------------------
// Sync: Payees
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
	execute: async () => {
		const payees = await fetchPayees();

		const changes = payees.map((payee) => ({
			type: "upsert" as const,
			key: payee.id,
			properties: {
				Payee: Builder.title(payee.name),
				"Payee ID": Builder.richText(payee.id),
				"Is Transfer": Builder.checkbox(
					payee.transfer_account_id != null,
				),
			},
		}));

		return { changes, hasMore: false };
	},
});

// ---------------------------------------------------------------------------
// Sync: Transactions (paginated — batches of 100)
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
			Amount: Schema.number(),
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
			Account: Schema.relation("ynabAccountsSync"),
			Payee: Schema.relation("ynabPayeesSync"),
			Category: Schema.relation("ynabCategoriesSync"),
			"Account Name": Schema.richText(),
			"Payee Name": Schema.richText(),
			"Category Name": Schema.richText(),
			"Is Transfer": Schema.checkbox(),
			"Is Split": Schema.checkbox(),
		},
	},
	execute: async (state: PaginationState | undefined) => {
		const offset = state?.offset ?? 0;

		// YNAB returns all transactions in one call (no server-side pagination).
		// We paginate locally in batches of 100 for the sync runtime.
		const allTransactions = await fetchTransactions();

		const batch = allTransactions.slice(offset, offset + PAGE_SIZE);
		const hasMore = offset + PAGE_SIZE < allTransactions.length;

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
			nextState: hasMore ? { offset: offset + PAGE_SIZE } : undefined,
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
			Income: Schema.number(),
			Budgeted: Schema.number(),
			Activity: Schema.number(),
			"To Be Budgeted": Schema.number(),
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
