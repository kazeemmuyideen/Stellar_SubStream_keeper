import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ChargeOutcome,
  EventKind,
  outcomeLabel,
  statusLabel,
  SubStreamClient,
  SubscriptionStatus,
  type IndexedEvent,
  type Plan,
  type Subscription,
} from "@substream/sdk";
import { config } from "./config";
import { connectWallet, freighterSigner } from "./wallet";
import {
  errorMessage,
  formatAmount,
  formatDate,
  formatDuration,
  parseAmount,
  shortAddress,
} from "./format";

type Tab = "market" | "subscriptions" | "activity" | "merchant" | "keeper";

interface Notice {
  kind: "ok" | "err" | "info";
  text: string;
  hash?: string;
}

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1_000));

async function fetchIndexedActivity(
  subscriber: string,
): Promise<IndexedEvent[] | null> {
  if (!config.indexerUrl) return null;
  try {
    const query = new URLSearchParams({ subscriber, limit: "200" });
    const url = `${config.indexerUrl.replace(/\/+$/, "")}/events?${query}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`indexer returned ${response.status}`);
    const payload = (await response.json()) as { events?: IndexedEvent[] };
    return Array.isArray(payload.events) ? payload.events : [];
  } catch {
    // The dApp still works without the indexer; ActivityList falls back to
    // the two milestones available from current contract state.
    return null;
  }
}

export default function App() {
  const [address, setAddress] = useState("");
  const [client, setClient] = useState<SubStreamClient | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [mySubscriptions, setMySubscriptions] = useState<Subscription[]>([]);
  const [allSubscriptions, setAllSubscriptions] = useState<Subscription[]>([]);
  const [activityEvents, setActivityEvents] = useState<IndexedEvent[]>([]);
  const [activityLive, setActivityLive] = useState(false);
  const [tab, setTab] = useState<Tab>("market");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [token, setToken] = useState(config.defaultToken);
  const [amount, setAmount] = useState("5");
  const [intervalDays, setIntervalDays] = useState("30");
  const [graceHours, setGraceHours] = useState("1");
  const [decimals, setDecimals] = useState("7");
  const [cycles, setCycles] = useState<Record<string, string>>({});

  const hasContract = Boolean(config.contractId);
  const signer = useMemo(
    () =>
      address
        ? freighterSigner(config.networkPassphrase, address)
        : null,
    [address],
  );

  const refresh = useCallback(
    async (activeClient = client, source = address) => {
      if (!activeClient || !source) return;
      const [allPlans, subscriptionIds, everySubscription] =
        await Promise.all([
          activeClient.getAllPlans(source, 50),
          activeClient.getSubscriberSubscriptions(source, source),
          activeClient.getAllSubscriptions(source, 50),
        ]);
      const [mine, indexed] = await Promise.all([
        activeClient.getSubscriptions(source, subscriptionIds),
        fetchIndexedActivity(source),
      ]);
      setPlans(allPlans);
      setMySubscriptions(mine);
      setAllSubscriptions(everySubscription);
      setActivityEvents(indexed ?? []);
      setActivityLive(indexed !== null);
    },
    [client, address],
  );

  useEffect(() => {
    if (!client || !address) return;
    void refresh().catch((error) =>
      setNotice({ kind: "err", text: errorMessage(error) }),
    );
  }, [client, address, refresh]);

  const merchantPlans = useMemo(
    () => plans.filter((plan) => plan.merchant === address),
    [plans, address],
  );

  const dueSubscriptions = useMemo(() => {
    const now = nowSeconds();
    return allSubscriptions.filter(
      (subscription) =>
        subscription.status !== SubscriptionStatus.Cancelled &&
        subscription.nextCharge <= now,
    );
  }, [allSubscriptions]);

  const totalEscrow = useMemo(
    () =>
      allSubscriptions.reduce(
        (sum, subscription) =>
          subscription.status === SubscriptionStatus.Cancelled
            ? sum
            : sum + subscription.balance,
        0n,
      ),
    [allSubscriptions],
  );

  async function handleConnect() {
    if (!hasContract) {
      setNotice({
        kind: "err",
        text: "Set VITE_CONTRACT_ID in apps/web/.env before connecting.",
      });
      return;
    }

    setBusy("connect");
    setNotice(null);
    try {
      const connected = await connectWallet(config.networkPassphrase);
      const nextClient = new SubStreamClient({
        contractId: config.contractId,
        rpcUrl: config.rpcUrl,
        networkPassphrase: config.networkPassphrase,
      });
      setAddress(connected);
      setClient(nextClient);
      setTab("market");
    } catch (error) {
      setNotice({ kind: "err", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function runAction(label: string, action: () => Promise<void>) {
    setBusy(label);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice({ kind: "err", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleCreatePlan(event: FormEvent) {
    event.preventDefault();
    if (!client || !signer) return;

    await runAction("create-plan", async () => {
      const tokenAddress = token.trim();
      if (!tokenAddress) {
        throw new Error("Paste the SAC token contract address.");
      }
      const amountBase = parseAmount(amount, Number(decimals));
      const interval = BigInt(
        Math.round(Number(intervalDays) * 86_400),
      );
      const grace = BigInt(Math.round(Number(graceHours) * 3_600));
      if (interval <= 0n) {
        throw new Error("Interval must be at least one day.");
      }
      if (grace < 0n) {
        throw new Error("Grace period cannot be negative.");
      }

      const { hash, planId } = await client.createPlan({
        merchant: address,
        token: tokenAddress,
        amount: amountBase,
        interval,
        gracePeriod: grace,
        signer,
      });
      setNotice({
        kind: "ok",
        text: `Plan #${planId} is live. Share it with subscribers.`,
        hash,
      });
      await refresh();
    });
  }

  async function handleSubscribe(plan: Plan) {
    if (!client || !signer) return;
    const count = Number(cycles[`plan-${plan.id}`] ?? "3");

    await runAction(`subscribe-${plan.id}`, async () => {
      if (!Number.isInteger(count) || count < 1) {
        throw new Error("Prepay at least one cycle.");
      }
      const { hash, subscriptionId } = await client.subscribe({
        subscriber: address,
        planId: plan.id,
        cycles: count,
        signer,
      });
      setNotice({
        kind: "ok",
        text: `Subscribed to plan #${plan.id}. Subscription #${subscriptionId} is active.`,
        hash,
      });
      await refresh();
      setTab("subscriptions");
    });
  }

  async function handleTopUp(subscription: Subscription) {
    if (!client || !signer) return;
    const count = Number(cycles[`sub-${subscription.id}`] ?? "1");

    await runAction(`topup-${subscription.id}`, async () => {
      if (!Number.isInteger(count) || count < 1) {
        throw new Error("Add at least one cycle.");
      }
      const { hash, balance } = await client.topUp({
        subscriber: address,
        subscriptionId: subscription.id,
        cycles: count,
        signer,
      });
      setNotice(
        balance === 0n
          ? {
              kind: "info",
              text: `Subscription #${subscription.id} was cancelled because its grace period had expired. Any remaining escrow was refunded.`,
              hash,
            }
          : {
              kind: "ok",
              text: `Subscription #${subscription.id} now holds ${formatAmount(balance, Number(decimals))} in escrow.`,
              hash,
            },
      );
      await refresh();
    });
  }

  async function handleCharge(subscription: Subscription) {
    if (!client || !signer) return;

    await runAction(`charge-${subscription.id}`, async () => {
      const { hash, outcome } = await client.charge({
        subscriptionId: subscription.id,
        source: address,
        signer,
      });
      setNotice({
        kind: outcome === ChargeOutcome.Charged ? "ok" : "info",
        text: `Subscription #${subscription.id}: ${outcomeLabel(outcome)}.`,
        hash,
      });
      await refresh();
    });
  }

  async function handleCancel(subscription: Subscription) {
    if (!client || !signer) return;

    await runAction(`cancel-${subscription.id}`, async () => {
      const { hash, refund } = await client.cancel({
        subscriber: address,
        subscriptionId: subscription.id,
        signer,
      });
      setNotice({
        kind: "ok",
        text: `Subscription #${subscription.id} cancelled. Refunded ${formatAmount(refund, Number(decimals))}.`,
        hash,
      });
      await refresh();
    });
  }

  async function handleTogglePlan(plan: Plan) {
    if (!client || !signer) return;

    await runAction(`toggle-${plan.id}`, async () => {
      const { hash } = await client.updatePlan({
        merchant: address,
        planId: plan.id,
        amount: plan.amount,
        interval: plan.interval,
        gracePeriod: plan.gracePeriod,
        active: !plan.active,
        signer,
      });
      setNotice({
        kind: "ok",
        text: `Plan #${plan.id} is now ${plan.active ? "paused" : "active"}.`,
        hash,
      });
      await refresh();
    });
  }

  const connected = Boolean(address && client);

  return (
    <div className="app-shell">
      <div className="grid-glow" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>SubStream</strong>
            <span className="brand-sub">recurring payments on Stellar</span>
          </div>
        </div>
        <div className="topbar-right">
          <span className="network-pill">
            <span className="dot" />
            {config.networkLabel}
          </span>
          {connected ? (
            <button
              className="wallet-chip"
              onClick={handleConnect}
              disabled={Boolean(busy)}
              title="Reconnect Freighter"
            >
              {shortAddress(address)}
            </button>
          ) : (
            <button
              className="primary"
              onClick={handleConnect}
              disabled={Boolean(busy) || !hasContract}
            >
              {busy === "connect" ? "Connecting…" : "Connect Freighter"}
            </button>
          )}
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">SCF 7.0 · Open Track primitive</span>
            <h1>
              Recurring payments,
              <br />
              <span className="accent">settled on Stellar.</span>
            </h1>
            <p>
              Subscribers prepay into Soroban escrow. Anyone can trigger the
              next charge when it is due. Cancel any time and the unused
              balance goes straight back to the subscriber.
            </p>
            <div className="hero-actions">
              <button
                className="primary"
                onClick={() => setTab("market")}
                disabled={!connected}
              >
                Browse plans
              </button>
              <button
                className="ghost"
                onClick={() => setTab("merchant")}
                disabled={!connected}
              >
                Create a plan
              </button>
            </div>
          </div>

          <div className="stats">
            <Stat label="Plans" value={plans.length.toString()} />
            <Stat
              label="Active subscriptions"
              value={allSubscriptions
                .filter(
                  (subscription) =>
                    subscription.status !== SubscriptionStatus.Cancelled,
                )
                .length.toString()}
            />
            <Stat
              label="Escrow under management"
              value={formatAmount(totalEscrow, Number(decimals))}
              hint="token base units"
            />
          </div>
        </section>

        {!hasContract && <SetupBanner />}

        {notice && (
          <Notice
            notice={notice}
            onClose={() => setNotice(null)}
            explorerBase={config.explorerBase}
          />
        )}

        {!connected ? (
          <section className="connect-panel">
            <div>
              <h2>Connect to open the dashboard</h2>
              <p>
                SubStream reads plans and subscriptions from Soroban RPC. Your
                Freighter wallet signs plan creation, subscriptions, top-ups,
                charges, and cancellations.
              </p>
            </div>
            <button
              className="primary"
              onClick={handleConnect}
              disabled={Boolean(busy) || !hasContract}
            >
              {busy === "connect" ? "Connecting…" : "Connect Freighter"}
            </button>
          </section>
        ) : (
          <>
            <nav className="tabs" aria-label="Dashboard sections">
              <TabButton active={tab === "market"} onClick={() => setTab("market")}>
                Market
              </TabButton>
              <TabButton
                active={tab === "subscriptions"}
                onClick={() => setTab("subscriptions")}
              >
                My subscriptions
              </TabButton>
              <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
                Activity
              </TabButton>
              <TabButton
                active={tab === "merchant"}
                onClick={() => setTab("merchant")}
              >
                Merchant
              </TabButton>
              <TabButton active={tab === "keeper"} onClick={() => setTab("keeper")}>
                Keeper
                {dueSubscriptions.length > 0 && (
                  <span className="badge">{dueSubscriptions.length}</span>
                )}
              </TabButton>
              <button
                className="ghost refresh"
                onClick={() =>
                  runAction("refresh", async () => {
                    await refresh();
                    setNotice({ kind: "info", text: "Dashboard refreshed." });
                  })
                }
                disabled={Boolean(busy)}
              >
                {busy === "refresh" ? "Refreshing…" : "Refresh"}
              </button>
            </nav>

            {tab === "market" && (
              <section className="section">
                <SectionHeading
                  title="Open plans"
                  description="Subscribe with a prepaid number of cycles. The plan terms are snapshotted at subscription time."
                />
                {plans.length === 0 ? (
                  <EmptyState
                    title="No plans yet"
                    body="Create the first billing plan from the Merchant tab."
                  />
                ) : (
                  <div className="card-grid">
                    {plans.map((plan) => (
                      <PlanCard
                        key={plan.id.toString()}
                        plan={plan}
                        decimals={Number(decimals)}
                        cycles={cycles[`plan-${plan.id}`] ?? "3"}
                        onCyclesChange={(value) =>
                          setCycles((current) => ({
                            ...current,
                            [`plan-${plan.id}`]: value,
                          }))
                        }
                        onSubscribe={() => handleSubscribe(plan)}
                        busy={Boolean(busy)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {tab === "subscriptions" && (
              <section className="section">
                <SectionHeading
                  title="My subscriptions"
                  description="Your prepaid escrow, next charge date, and cancellation controls."
                />
                {mySubscriptions.length === 0 ? (
                  <EmptyState
                    title="No subscriptions"
                    body="Pick a plan in the Market tab to start one."
                  />
                ) : (
                  <div className="stack">
                    {mySubscriptions.map((subscription) => (
                      <SubscriptionCard
                        key={subscription.id.toString()}
                        subscription={subscription}
                        decimals={Number(decimals)}
                        cycles={cycles[`sub-${subscription.id}`] ?? "1"}
                        onCyclesChange={(value) =>
                          setCycles((current) => ({
                            ...current,
                            [`sub-${subscription.id}`]: value,
                          }))
                        }
                        onTopUp={() => handleTopUp(subscription)}
                        onCharge={() => handleCharge(subscription)}
                        onCancel={() => handleCancel(subscription)}
                        busy={Boolean(busy)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {tab === "activity" && (
              <section className="section">
                <SectionHeading
                  title="Subscription activity"
                  description="Recent on-chain subscription milestones and current payment status."
                />
                <ActivityList
                events={activityEvents}
                live={activityLive}
                subscriptions={mySubscriptions}
                decimals={Number(decimals)}
                explorerBase={config.explorerBase}
              />
              </section>
            )}

            {tab === "merchant" && (
              <section className="section">
                <SectionHeading
                  title="Merchant console"
                  description="Create a reusable plan, then pause or resume it. Existing subscriptions keep their original terms."
                />
                <div className="merchant-layout">
                  <form className="card form-card" onSubmit={handleCreatePlan}>
                    <h3>New plan</h3>
                    <Field label="Token contract (SAC)">
                      <input
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        placeholder="C…"
                        spellCheck={false}
                      />
                    </Field>
                    <div className="field-row">
                      <Field label="Amount per cycle">
                        <input
                          value={amount}
                          onChange={(event) => setAmount(event.target.value)}
                          inputMode="decimal"
                        />
                      </Field>
                      <Field label="Token decimals">
                        <input
                          value={decimals}
                          onChange={(event) => setDecimals(event.target.value)}
                          inputMode="numeric"
                        />
                      </Field>
                    </div>
                    <div className="field-row">
                      <Field label="Interval (days)">
                        <input
                          value={intervalDays}
                          onChange={(event) =>
                            setIntervalDays(event.target.value)
                          }
                          inputMode="decimal"
                        />
                      </Field>
                      <Field label="Grace period (hours)">
                        <input
                          value={graceHours}
                          onChange={(event) => setGraceHours(event.target.value)}
                          inputMode="decimal"
                        />
                      </Field>
                    </div>
                    <button
                      className="primary full"
                      type="submit"
                      disabled={Boolean(busy)}
                    >
                      {busy === "create-plan" ? "Creating…" : "Create plan"}
                    </button>
                    <p className="fineprint">
                      The plan is stored on-chain. The token must be a SAC
                      contract address on the configured network.
                    </p>
                  </form>

                  <div className="merchant-plans">
                    <h3>My plans</h3>
                    {merchantPlans.length === 0 ? (
                      <EmptyState
                        title="No plans from this wallet"
                        body="Create one on the left. It will appear here immediately."
                      />
                    ) : (
                      <div className="stack">
                        {merchantPlans.map((plan) => (
                          <PlanCard
                            key={plan.id.toString()}
                            plan={plan}
                            decimals={Number(decimals)}
                            cycles={cycles[`plan-${plan.id}`] ?? "3"}
                            onCyclesChange={(value) =>
                              setCycles((current) => ({
                                ...current,
                                [`plan-${plan.id}`]: value,
                              }))
                            }
                            onSubscribe={() => handleSubscribe(plan)}
                            onToggle={() => handleTogglePlan(plan)}
                            busy={Boolean(busy)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {tab === "keeper" && (
              <section className="section">
                <SectionHeading
                  title="Keeper queue"
                  description="Charging is permissionless. This tab is a manual keeper: it submits due charges from your wallet. The background keeper service does the same thing on a loop."
                />
                {dueSubscriptions.length === 0 ? (
                  <EmptyState
                    title="Nothing due"
                    body="When a subscription reaches its next charge time, it appears here."
                  />
                ) : (
                  <div className="stack">
                    {dueSubscriptions.map((subscription) => (
                      <div className="card keeper-row" key={subscription.id.toString()}>
                        <div>
                          <span className="eyebrow">
                            Subscription #{subscription.id.toString()}
                          </span>
                          <h3>
                            {formatAmount(
                              subscription.amount,
                              Number(decimals),
                            )}{" "}
                            due for plan #{subscription.planId.toString()}
                          </h3>
                          <p className="muted">
                            Subscriber {shortAddress(subscription.subscriber)} ·
                            next charge {formatDate(subscription.nextCharge)}
                          </p>
                        </div>
                        <button
                          className="primary"
                          onClick={() => handleCharge(subscription)}
                          disabled={Boolean(busy)}
                        >
                          {busy === `charge-${subscription.id}`
                            ? "Charging…"
                            : "Charge now"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>

      <footer>
        <span>SubStream · MIT licensed</span>
        <span>
          Soroban escrow · SAC tokens · permissionless keepers · open source
        </span>
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`tab ${active ? "tab-active" : ""}`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

interface ActivityRow {
  id: string;
  timestamp: bigint;
  title: string;
  detail: string;
  status?: number;
  txHash?: string;
}

function activityAmount(value: string | null, decimals: number): string {
  if (value === null) return "—";
  try {
    return formatAmount(BigInt(value), decimals);
  } catch {
    return value;
  }
}

function activityDate(value: string | null): string {
  if (value === null) return "—";
  try {
    return formatDate(BigInt(value));
  } catch {
    return "—";
  }
}

function cancellationReason(reason: number | null): string {
  switch (reason) {
    case 0:
      return "subscriber cancelled";
    case 1:
      return "grace period expired";
    case 2:
      return "merchant cancelled";
    default:
      return "unknown reason";
  }
}

function indexedRow(
  event: IndexedEvent,
  decimals: number,
  subscriptions: Subscription[],
): ActivityRow {
  const subscription = subscriptions.find(
    (item) => item.id.toString() === event.subscriptionId,
  );
  const base: ActivityRow = {
    id: event.id,
    timestamp: Number.isFinite(event.timestamp)
      ? BigInt(Math.floor(event.timestamp))
      : 0n,
    title: "Contract event",
    detail: "",
    status: subscription?.status,
    txHash: event.txHash,
  };
  const sub = event.subscriptionId ? `#${event.subscriptionId}` : "#?";
  const plan = event.planId ? `#${event.planId}` : "#?";

  switch (event.kind) {
    case EventKind.Subscribed:
      return {
        ...base,
        title: `Subscription ${sub} started`,
        detail: `Plan ${plan} · deposit ${activityAmount(event.amount, decimals)}`,
      };
    case EventKind.ToppedUp:
      return {
        ...base,
        title: `Top-up on subscription ${sub}`,
        detail: `+${activityAmount(event.amount, decimals)} · escrow ${activityAmount(event.balance, decimals)}`,
      };
    case EventKind.Charged:
      return {
        ...base,
        title: `Payment settled for subscription ${sub}`,
        detail: `${activityAmount(event.amount, decimals)} charged · next charge ${activityDate(event.nextCharge)}`,
      };
    case EventKind.PaymentFailed:
      return {
        ...base,
        title: `Payment failed for subscription ${sub}`,
        detail: `Escrow ${activityAmount(event.balance, decimals)} · top up before the grace period ends`,
      };
    case EventKind.Cancelled:
      return {
        ...base,
        title: `Subscription ${sub} cancelled`,
        detail: `${cancellationReason(event.reason)} · escrow refunded`,
      };
    case EventKind.PlanCreated:
      return {
        ...base,
        title: `Plan ${plan} created`,
        detail: `Merchant ${shortAddress(event.subscriber ?? "")}`,
      };
    case EventKind.PlanUpdated:
      return { ...base, title: `Plan ${plan} updated` };
    default:
      return {
        ...base,
        title: `${event.kind} event`,
        detail: event.subscriptionId ? `Subscription ${sub}` : `Plan ${plan}`,
      };
  }
}

function ActivityList({
  events,
  live,
  subscriptions,
  decimals,
  explorerBase,
}: {
  events: IndexedEvent[];
  live: boolean;
  subscriptions: Subscription[];
  decimals: number;
  explorerBase: string;
}) {
  const useIndexed = events.length > 0;
  const rows: ActivityRow[] = useIndexed
    ? events.map((event) => indexedRow(event, decimals, subscriptions))
    : subscriptions
        .flatMap((subscription) => {
          const history = [
            {
              id: `${subscription.id}-started`,
              timestamp: subscription.startedAt,
              title: `Subscription #${subscription.id} started`,
              detail: `Plan #${subscription.planId} · current escrow ${formatAmount(subscription.balance, decimals)} · ${subscription.cyclesPaid} cycle(s) paid`,
            },
          ];
          if (subscription.lastChargedAt > 0n) {
            history.push({
              id: `${subscription.id}-charged`,
              timestamp: subscription.lastChargedAt,
              title: `Payment settled for subscription #${subscription.id}`,
              detail: `${formatAmount(subscription.amount, decimals)} · ${subscription.cyclesPaid} cycle(s) paid`,
            });
          }
          return history.map((item) => ({
            ...item,
            status: subscription.status,
          }));
        })
        .sort((a, b) =>
          a.timestamp > b.timestamp ? -1 : a.timestamp < b.timestamp ? 1 : 0,
        );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        body="Your subscription milestones will appear here after you subscribe to a plan."
      />
    );
  }

  return (
    <div className="activity-list">
      {rows.map((row) => (
        <article className="card activity-row" key={row.id}>
          <span className="activity-marker" aria-hidden="true" />
          <div className="activity-copy">
            <strong>{row.title}</strong>
            <span>{row.detail}</span>
          </div>
          <div className="activity-meta">
            {row.status !== undefined && (
              <span
                className={`pill ${
                  row.status === SubscriptionStatus.PastDue
                    ? "pill-warn"
                    : row.status === SubscriptionStatus.Cancelled
                      ? "pill-off"
                      : "pill-on"
                }`}
              >
                {statusLabel(row.status)}
              </span>
            )}
            <time>{formatDate(row.timestamp)}</time>
            {row.txHash && (
              <a
                className="activity-tx"
                href={`${explorerBase}/${row.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction ↗
              </a>
            )}
          </div>
        </article>
      ))}
      <p className="fineprint">
        {useIndexed
          ? "Full history decoded from on-chain contract events by the SubStream indexer."
          : live
            ? "The indexer is reachable but has not recorded events yet; showing the start and most recent charge from current contract state."
            : "The indexer is not configured. Showing the start and most recent charge from current contract state; older transactions are not retained by the contract."}
      </p>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function PlanCard({
  plan,
  decimals,
  cycles,
  onCyclesChange,
  onSubscribe,
  onToggle,
  busy,
}: {
  plan: Plan;
  decimals: number;
  cycles: string;
  onCyclesChange: (value: string) => void;
  onSubscribe: () => void;
  onToggle?: () => void;
  busy: boolean;
}) {
  return (
    <article className="card plan-card">
      <div className="card-top">
        <span className="eyebrow">Plan #{plan.id.toString()}</span>
        <span className={`pill ${plan.active ? "pill-on" : "pill-off"}`}>
          {plan.active ? "Active" : "Paused"}
        </span>
      </div>

      <h3>
        {formatAmount(plan.amount, decimals)}{" "}
        <span className="unit">per {formatDuration(plan.interval)}</span>
      </h3>

      <dl className="facts">
        <div>
          <dt>Merchant</dt>
          <dd title={plan.merchant}>{shortAddress(plan.merchant)}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd title={plan.token}>{shortAddress(plan.token)}</dd>
        </div>
        <div>
          <dt>Grace</dt>
          <dd>{formatDuration(plan.gracePeriod)}</dd>
        </div>
      </dl>

      <div className="inline-form">
        <label>
          Prepay cycles
          <input
            value={cycles}
            onChange={(event) => onCyclesChange(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <button
          className="primary"
          onClick={onSubscribe}
          disabled={busy || !plan.active}
        >
          Subscribe
        </button>
      </div>

      {onToggle && (
        <button
          className="ghost full"
          onClick={onToggle}
          disabled={busy}
          type="button"
        >
          {plan.active ? "Pause new charges" : "Resume plan"}
        </button>
      )}
    </article>
  );
}

function SubscriptionCard({
  subscription,
  decimals,
  cycles,
  onCyclesChange,
  onTopUp,
  onCharge,
  onCancel,
  busy,
}: {
  subscription: Subscription;
  decimals: number;
  cycles: string;
  onCyclesChange: (value: string) => void;
  onTopUp: () => void;
  onCharge: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const cancelled = subscription.status === SubscriptionStatus.Cancelled;
  const pastDue = subscription.status === SubscriptionStatus.PastDue;
  const due =
    !cancelled && subscription.nextCharge <= nowSeconds();

  return (
    <article className={`card subscription-card ${cancelled ? "is-muted" : ""}`}>
      <div className="card-top">
        <span className="eyebrow">
          Subscription #{subscription.id.toString()} · plan #
          {subscription.planId.toString()}
        </span>
        <span
          className={`pill ${
            cancelled ? "pill-off" : pastDue ? "pill-warn" : "pill-on"
          }`}
        >
          {statusLabel(subscription.status)}
        </span>
      </div>

      <div className="sub-grid">
        <div>
          <span className="muted">Escrow balance</span>
          <strong>{formatAmount(subscription.balance, decimals)}</strong>
        </div>
        <div>
          <span className="muted">Per cycle</span>
          <strong>{formatAmount(subscription.amount, decimals)}</strong>
        </div>
        <div>
          <span className="muted">Next charge</span>
          <strong>{formatDate(subscription.nextCharge)}</strong>
        </div>
        <div>
          <span className="muted">Cycles paid</span>
          <strong>{subscription.cyclesPaid.toString()}</strong>
        </div>
      </div>

      {!cancelled && (
        <div className="actions">
          <div className="inline-form">
            <label>
              Add cycles
              <input
                value={cycles}
                onChange={(event) => onCyclesChange(event.target.value)}
                inputMode="numeric"
              />
            </label>
            <button className="ghost" onClick={onTopUp} disabled={busy}>
              Top up
            </button>
          </div>
          <div className="action-row">
            <button
              className="primary"
              onClick={onCharge}
              disabled={busy || !due}
              title={due ? "Charge is due" : "Not due yet"}
            >
              {due ? "Charge now" : "Not due"}
            </button>
            <button className="danger" onClick={onCancel} disabled={busy}>
              Cancel & refund
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function SetupBanner() {
  return (
    <section className="setup-banner">
      <div>
        <strong>Contract not configured</strong>
        <p>
          Deploy the Soroban contract, then copy{" "}
          <code>apps/web/.env.example</code> to <code>apps/web/.env</code> and
          set <code>VITE_CONTRACT_ID</code>.
        </p>
      </div>
      <code className="setup-code">
        ./scripts/deploy.sh testnet
      </code>
    </section>
  );
}

function Notice({
  notice,
  onClose,
  explorerBase,
}: {
  notice: Notice;
  onClose: () => void;
  explorerBase: string;
}) {
  return (
    <div className={`notice notice-${notice.kind}`} role="status">
      <div>
        <strong>{notice.text}</strong>
        {notice.hash && (
          <a
            href={`${explorerBase}/${notice.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
        )}
      </div>
      <button className="notice-close" onClick={onClose} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
