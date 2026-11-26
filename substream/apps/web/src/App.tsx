import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ChargeOutcome,
  EventKind,
  outcomeLabel,
  statusLabel,
  SubStreamClient,
  SubscriptionStatus,
  type IndexedEvent,
  type MetricsResponse,
  type Plan,
  type Subscription,
  type TokenAmount,
} from "@substream/sdk";
import {
  downloadCsv,
  formatBps,
  metricsToCsv,
  successRateBps,
  tokenShares,
} from "./analytics";
import { config } from "./config";
import {
  demoStage,
  filterSubscriptions,
  isDue,
  type DemoStage,
  type SubscriptionFilter,
} from "./dashboard";
import {
  isMetricsResponse,
  MAX_METRICS_RESPONSE_CHARS,
} from "./metrics";
import { connectWallet, freighterSigner } from "./wallet";
import {
  errorMessage,
  formatAmount,
  formatDate,
  formatDuration,
  parseAmount,
  shortAddress,
} from "./format";

type Tab =
  | "guide"
  | "market"
  | "subscriptions"
  | "activity"
  | "analytics"
  | "merchant"
  | "keeper";

interface Notice {
  kind: "ok" | "err" | "info";
  text: string;
  hash?: string;
}

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1_000));

async function fetchIndexerJson<T>(
  path: string,
  params: Record<string, string> = {},
  maxChars = 1_000_000,
): Promise<T | null> {
  if (!config.indexerUrl) return null;
  try {
    const query = new URLSearchParams(params).toString();
    const suffix = query ? `?${query}` : "";
    const url = `${config.indexerUrl.replace(/\/+$/, "")}${path}${suffix}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`indexer returned ${response.status}`);

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > maxChars) {
      throw new Error("indexer response is too large");
    }
    const text = await response.text();
    if (text.length > maxChars) {
      throw new Error("indexer response is too large");
    }

    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function fetchIndexedActivity(
  subscriber: string,
): Promise<IndexedEvent[] | null> {
  const payload = await fetchIndexerJson<{ events?: unknown }>("/events", {
    subscriber,
    limit: "200",
  });
  if (!payload || !Array.isArray(payload.events)) return null;
  return (payload.events as IndexedEvent[]).slice(0, 200);
}

async function fetchMerchantMetrics(
  merchant: string,
): Promise<MetricsResponse | null> {
  const payload = await fetchIndexerJson<unknown>(
    "/metrics",
    { merchant },
    MAX_METRICS_RESPONSE_CHARS,
  );
  return isMetricsResponse(payload) ? payload : null;
}

async function fetchNetworkMetrics(): Promise<MetricsResponse | null> {
  const payload = await fetchIndexerJson<unknown>(
    "/metrics",
    {},
    MAX_METRICS_RESPONSE_CHARS,
  );
  return isMetricsResponse(payload) ? payload : null;
}

export default function App() {
  const [address, setAddress] = useState("");
  const [client, setClient] = useState<SubStreamClient | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [mySubscriptions, setMySubscriptions] = useState<Subscription[]>([]);
  const [allSubscriptions, setAllSubscriptions] = useState<Subscription[]>([]);
  const [activityEvents, setActivityEvents] = useState<IndexedEvent[]>([]);
  const [activityLive, setActivityLive] = useState(false);
  const [merchantMetrics, setMerchantMetrics] =
    useState<MetricsResponse | null>(null);
  const [networkMetrics, setNetworkMetrics] =
    useState<MetricsResponse | null>(null);
  const [tab, setTab] = useState<Tab>("guide");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [clock, setClock] = useState(nowSeconds());
  const [subscriptionFilter, setSubscriptionFilter] =
    useState<SubscriptionFilter>("all");
  const [subscriptionQuery, setSubscriptionQuery] = useState("");
  const [demoPlanId, setDemoPlanId] = useState<bigint | null>(null);
  const [demoSubscriptionId, setDemoSubscriptionId] = useState<bigint | null>(
    null,
  );

  const [token, setToken] = useState(config.defaultToken);
  const [amount, setAmount] = useState("5");
  const [intervalDays, setIntervalDays] = useState("30");
  const [graceHours, setGraceHours] = useState("1");
  const [decimals, setDecimals] = useState("7");
  const [cycles, setCycles] = useState<Record<string, string>>({});
  const [metricsTick, setMetricsTick] = useState(0);
  const refreshGeneration = useRef(0);

  const parsedDecimals = Number(decimals);
  const displayDecimals =
    Number.isInteger(parsedDecimals) &&
    parsedDecimals >= 0 &&
    parsedDecimals <= 18
      ? parsedDecimals
      : 7;

  const hasContract = Boolean(config.contractId);
  const signer = useMemo(
    () =>
      address
        ? freighterSigner(config.networkPassphrase, address)
        : null,
    [address],
  );
  const connected = Boolean(address && client);

  const refresh = useCallback(
    async (activeClient = client, source = address) => {
      if (!activeClient || !source) return;
      const generation = ++refreshGeneration.current;
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
      if (generation !== refreshGeneration.current) return;
      setPlans(allPlans);
      setMySubscriptions(mine);
      setAllSubscriptions(everySubscription);
      setActivityEvents(indexed ?? []);
      setActivityLive(indexed !== null);
      // Contract writes can change metrics; re-read them once the RPC state
      // used by this refresh is committed.
      setMetricsTick((tick) => tick + 1);
    },
    [client, address],
  );

  useEffect(() => {
    if (!client || !address) return;
    void refresh().catch((error) =>
      setNotice({ kind: "err", text: errorMessage(error) }),
    );
  }, [client, address, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMetricsTick((tick) => tick + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(nowSeconds()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    if (!address) setMerchantMetrics(null);
    void Promise.all([
      fetchNetworkMetrics(),
      address ? fetchMerchantMetrics(address) : Promise.resolve(null),
    ]).then(([network, merchant]) => {
      if (!active) return;
      setNetworkMetrics(network);
      if (address) setMerchantMetrics(merchant);
    });
    return () => {
      active = false;
    };
  }, [address, metricsTick]);

  const merchantPlans = useMemo(
    () => plans.filter((plan) => plan.merchant === address),
    [plans, address],
  );

  const dueSubscriptions = useMemo(
    () => allSubscriptions.filter((subscription) => isDue(subscription, clock)),
    [allSubscriptions, clock],
  );

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

  const demoPlan = useMemo(
    () =>
      plans.find((plan) => plan.id === demoPlanId) ??
      plans.find((plan) => plan.active) ??
      plans[0],
    [plans, demoPlanId],
  );

  const demoSubscription = useMemo(
    () =>
      mySubscriptions.find(
        (subscription) => subscription.id === demoSubscriptionId,
      ) ?? mySubscriptions[0],
    [mySubscriptions, demoSubscriptionId],
  );

  const currentStage = useMemo<DemoStage>(
    () =>
      demoStage({
        connected,
        hasPlan: plans.length > 0,
        hasSubscription: mySubscriptions.length > 0,
        hasDueSubscription: Boolean(
          demoSubscription && isDue(demoSubscription, clock),
        ),
        hasCancelledSubscription: Boolean(
          demoSubscription?.status === SubscriptionStatus.Cancelled,
        ),
      }),
    [connected, plans.length, mySubscriptions.length, demoSubscription, clock],
  );

  const visibleSubscriptions = useMemo(
    () =>
      filterSubscriptions(mySubscriptions, subscriptionFilter, subscriptionQuery),
    [mySubscriptions, subscriptionFilter, subscriptionQuery],
  );

  const merchantSubscriptions = useMemo(
    () =>
      allSubscriptions.filter((subscription) =>
        merchantPlans.some((plan) => plan.id === subscription.planId),
      ),
    [allSubscriptions, merchantPlans],
  );

  const latestDemoTx = useMemo(
    () =>
      activityEvents.find(
        (event) =>
          demoSubscription &&
          event.subscriptionId === demoSubscription.id.toString(),
      )?.txHash,
    [activityEvents, demoSubscription],
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
      if (config.e2eFixtures) {
        const { E2E_ADDRESS, E2E_TOKEN, E2EClient } = await import(
          "./e2e-fixtures"
        );
        setAddress(E2E_ADDRESS);
        setToken(E2E_TOKEN);
        setClient(new E2EClient() as unknown as SubStreamClient);
        setTab("guide");
        return;
      }

      const connected = await connectWallet(config.networkPassphrase);
      const nextClient = new SubStreamClient({
        contractId: config.contractId,
        rpcUrl: config.rpcUrl,
        networkPassphrase: config.networkPassphrase,
        maxFee: config.maxFee,
      });
      setAddress(connected);
      setClient(nextClient);
      setTab("guide");
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
      if (
        !Number.isInteger(parsedDecimals) ||
        parsedDecimals < 0 ||
        parsedDecimals > 18
      ) {
        throw new Error("Decimals must be an integer between 0 and 18.");
      }
      const amountBase = parseAmount(amount, parsedDecimals);
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

  async function handleCreateDemoPlan() {
    if (!client || !signer) return;

    await runAction("demo-plan", async () => {
      const demoToken = token.trim() || config.defaultToken;
      if (!demoToken) {
        throw new Error("Set VITE_TOKEN_ADDRESS to enable the guided demo.");
      }
      const { hash, planId } = await client.createPlan({
        merchant: address,
        token: demoToken,
        amount: parseAmount("1", parsedDecimals),
        interval: 10n,
        gracePeriod: 3600n,
        signer,
      });
      setToken(demoToken);
      setDemoPlanId(planId);
      setNotice({
        kind: "ok",
        text: `Demo plan #${planId} is live: 1 token every 10 seconds.`,
        hash,
      });
      await refresh();
    });
  }

  async function handleSubscribe(
    plan: Plan,
    options: { keepTab?: boolean; demo?: boolean } = {},
  ) {
    if (!client || !signer) return;
    const count = options.demo ? 2 : Number(cycles[`plan-${plan.id}`] ?? "3");

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
      if (options.demo) setDemoSubscriptionId(subscriptionId);
      await refresh();
      if (!options.keepTab) setTab("subscriptions");
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
              text: `Subscription #${subscription.id} now holds ${formatAmount(balance, displayDecimals)} in escrow.`,
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
        text: `Subscription #${subscription.id} cancelled. Refunded ${formatAmount(refund, displayDecimals)}.`,
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
              <button className="primary" onClick={() => setTab("guide")}>
                Start guided demo
              </button>
              <button
                className="ghost"
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
              value={formatAmount(totalEscrow, displayDecimals)}
              hint="token base units"
            />
            <Stat
              label="Indexed charges"
              value={(networkMetrics?.network.charges ?? 0).toString()}
              hint={networkMetrics ? "public indexer metrics" : "indexer offline"}
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
                charges, and cancellations. After connecting, the guided demo
                walks through the whole lifecycle in six steps.
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
              <TabButton active={tab === "guide"} onClick={() => setTab("guide")}>
                Guided demo
              </TabButton>
              <TabButton active={tab === "market"} onClick={() => setTab("market")}>
                Market
              </TabButton>
              <TabButton
                active={tab === "subscriptions"}
                onClick={() => setTab("subscriptions")}
              >
                Subscriptions
              </TabButton>
              <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
                Activity
              </TabButton>
              <TabButton
                active={tab === "analytics"}
                onClick={() => setTab("analytics")}
              >
                Public metrics
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

            {tab === "guide" && (
              <section className="section">
                <SectionHeading
                  title="Guided demo"
                  description="Your wallet acts as both merchant and subscriber, so one account can complete the full lifecycle without a second signer."
                />
                <GuidedDemo
                  stage={currentStage}
                  plan={demoPlan}
                  subscription={demoSubscription}
                  now={clock}
                  decimals={displayDecimals}
                  explorerBase={config.explorerBase}
                  explorerTx={latestDemoTx}
                  busy={Boolean(busy)}
                  onConnect={handleConnect}
                  onCreatePlan={handleCreateDemoPlan}
                  onSubscribe={() =>
                    demoPlan && handleSubscribe(demoPlan, { keepTab: true, demo: true })
                  }
                  onCharge={() =>
                    demoSubscription && handleCharge(demoSubscription)
                  }
                  onCancel={() =>
                    demoSubscription && handleCancel(demoSubscription)
                  }
                  onManage={() => setTab("subscriptions")}
                  onBrowse={() => setTab("market")}
                />
              </section>
            )}

            {tab === "market" && (
              <section className="section">
                <SectionHeading
                  title="Open plans"
                  description="Subscribe with a prepaid number of cycles. The plan terms are snapshotted at subscription time."
                />
                {plans.length === 0 ? (
                  <EmptyState
                    title="No plans yet"
                    body="Use the guided demo for a 10-second plan, or create a custom plan in the Merchant tab."
                  />
                ) : (
                  <div className="card-grid">
                    {plans.map((plan) => (
                      <PlanCard
                        key={plan.id.toString()}
                        plan={plan}
                        decimals={displayDecimals}
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
                  title="Subscription manager"
                  description="Track prepaid escrow, next charge dates, and cancellation controls, plus subscriptions to plans you publish."
                />
                <div className="stats manager-stats">
                  <Stat
                    label="Active"
                    value={mySubscriptions
                      .filter(
                        (subscription) =>
                          subscription.status === SubscriptionStatus.Active,
                      )
                      .length.toString()}
                  />
                  <Stat
                    label="Past due"
                    value={mySubscriptions
                      .filter(
                        (subscription) =>
                          subscription.status === SubscriptionStatus.PastDue,
                      )
                      .length.toString()}
                  />
                  <Stat
                    label="My escrow"
                    value={formatAmount(
                      mySubscriptions.reduce(
                        (sum, subscription) =>
                          subscription.status === SubscriptionStatus.Cancelled
                            ? sum
                            : sum + subscription.balance,
                        0n,
                      ),
                      displayDecimals,
                    )}
                  />
                  <Stat
                    label="Plan subscribers"
                    value={merchantSubscriptions.length.toString()}
                    hint="subscriptions to my plans"
                  />
                </div>

                <div className="manager-toolbar">
                  <div className="segmented" aria-label="Filter subscriptions">
                    {(
                      [
                        ["all", "All"],
                        ["active", "Active"],
                        ["past-due", "Past due"],
                        ["cancelled", "Cancelled"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={
                          subscriptionFilter === value ? "segment-active" : ""
                        }
                        onClick={() => setSubscriptionFilter(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <input
                    className="search-input"
                    value={subscriptionQuery}
                    onChange={(event) => setSubscriptionQuery(event.target.value)}
                    placeholder="Search id, plan, or address"
                    aria-label="Search subscriptions"
                  />
                </div>

                {visibleSubscriptions.length === 0 ? (
                  <EmptyState
                    title={
                      mySubscriptions.length === 0
                        ? "No subscriptions"
                        : "No matching subscriptions"
                    }
                    body={
                      mySubscriptions.length === 0
                        ? "Pick a plan in the Market tab or use the guided demo to start one."
                        : "Change the filter or search text to see more subscriptions."
                    }
                  />
                ) : (
                  <div className="stack">
                    {visibleSubscriptions.map((subscription) => (
                      <SubscriptionCard
                        key={subscription.id.toString()}
                        subscription={subscription}
                        viewer={address}
                        now={clock}
                        decimals={displayDecimals}
                        cycles={cycles[`sub-${subscription.id}`] ?? "1"}
                        explorerBase={config.explorerBase}
                        explorerTx={activityEvents.find(
                          (event) =>
                            event.subscriptionId === subscription.id.toString(),
                        )?.txHash}
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

                <div className="sub-section">
                  <div className="sub-section-head">
                    <h3>Subscriptions to my plans</h3>
                    <span className="muted">
                      {merchantSubscriptions.length} on-chain subscription
                      {merchantSubscriptions.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {merchantSubscriptions.length === 0 ? (
                    <EmptyState
                      title="No subscribers yet"
                      body="Share one of your merchant plans to see subscriber activity here."
                    />
                  ) : (
                    <div className="stack">
                      {merchantSubscriptions.map((subscription) => (
                        <MerchantSubscriptionRow
                          key={subscription.id.toString()}
                          subscription={subscription}
                          viewer={address}
                          now={clock}
                          decimals={displayDecimals}
                          explorerContractBase={config.explorerContractBase}
                        />
                      ))}
                    </div>
                  )}
                </div>
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
                decimals={displayDecimals}
                explorerBase={config.explorerBase}
              />
              </section>
            )}

            {tab === "analytics" && (
              <section className="section">
                <SectionHeading
                  title="Public metrics"
                  description="Network-wide, indexer-derived counters. These are cumulative lifetime totals from decoded events, not audited on-chain accounting."
                />
                <NetworkAnalytics
                  payload={networkMetrics}
                  live={networkMetrics !== null}
                  configured={Boolean(config.indexerUrl)}
                  decimals={displayDecimals}
                />
              </section>
            )}

            {tab === "merchant" && (
              <section className="section">
                <SectionHeading
                  title="Merchant console"
                  description="Create a reusable plan, then pause or resume it. Existing subscriptions keep their original terms."
                />
                <MerchantAnalytics
                  payload={merchantMetrics}
                  live={merchantMetrics !== null}
                  configured={Boolean(config.indexerUrl)}
                  decimals={displayDecimals}
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
                            decimals={displayDecimals}
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
                              displayDecimals,
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

function formatTokenAmounts(
  amounts: TokenAmount[],
  decimals: number,
): string {
  if (amounts.length === 0) return "—";
  return amounts
    .map(
      (item) =>
        `${activityAmount(item.amount, decimals)} · ${shortAddress(item.token)}`,
    )
    .join(", ");
}

function TokenAmountList({
  amounts,
  decimals,
  emptyLabel,
}: {
  amounts: TokenAmount[];
  decimals: number;
  emptyLabel: string;
}) {
  if (amounts.length === 0) return <p className="muted">{emptyLabel}</p>;
  return (
    <div className="token-amounts">
      {amounts.map((item) => (
        <div key={item.token}>
          <span title={item.token}>{shortAddress(item.token)}</span>
          <strong>{activityAmount(item.amount, decimals)}</strong>
        </div>
      ))}
    </div>
  );
}

interface ChartItem {
  label: string;
  value: number;
  display: string;
  title?: string;
}

function ChartBars({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: ChartItem[];
  emptyLabel: string;
}) {
  const max = Math.max(0, ...items.map((item) => item.value));
  return (
    <div className="chart-block">
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="muted">{emptyLabel}</p>
      ) : (
        <div className="bar-chart">
          {items.map((item) => (
            <div className="bar-row" key={item.label}>
              <span title={item.title ?? item.label}>{item.label}</span>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{
                    width:
                      item.value === 0 || max === 0
                        ? "0%"
                        : `${Math.max(3, Math.round((item.value / max) * 100))}%`,
                  }}
                />
              </div>
              <strong>{item.display}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SuccessMeter({
  succeeded,
  failed,
}: {
  succeeded: number;
  failed: number;
}) {
  const bps = successRateBps(succeeded, failed);
  return (
    <div className="chart-block">
      <h4>Charge success rate</h4>
      <div className="meter-row">
        <strong>{formatBps(bps)}</strong>
        <span className="muted">
          {succeeded} settled · {failed} failed
        </span>
      </div>
      <div className="bar-track meter-track">
        <div className="bar-fill meter-fill" style={{ width: `${(bps ?? 0) / 100}%` }} />
      </div>
    </div>
  );
}

function ExportButton({
  payload,
  scope,
}: {
  payload: MetricsResponse;
  scope: string;
}) {
  return (
    <button
      className="ghost export-button"
      type="button"
      onClick={() =>
        downloadCsv(
          `substream-${scope}-metrics-${new Date().toISOString().slice(0, 10)}.csv`,
          metricsToCsv(payload),
        )
      }
    >
      Export CSV
    </button>
  );
}

function MerchantAnalytics({
  payload,
  live,
  configured,
  decimals,
}: {
  payload: MetricsResponse | null;
  live: boolean;
  configured: boolean;
  decimals: number;
}) {
  const metrics = payload?.merchant;
  const revenueShares = metrics ? tokenShares(metrics.charged) : [];
  const refundShares = metrics ? tokenShares(metrics.refunded) : [];

  return (
    <section className="card analytics-card">
      <div className="card-top">
        <div>
          <span className="eyebrow">Merchant analytics</span>
          <h3>
            {metrics
              ? `Metrics for ${shortAddress(metrics.merchant)}`
              : "No indexed merchant activity"}
          </h3>
        </div>
        <div className="analytics-actions">
          {live && payload && <ExportButton payload={payload} scope="merchant" />}
          <span className={`pill ${live ? "pill-on" : "pill-off"}`}>
            {live ? "Live" : "Offline"}
          </span>
        </div>
      </div>

      {!live ? (
        <p className="muted">
          {configured ? (
            <>
              The indexer is unreachable, so merchant metrics are temporarily
              unavailable. Contract state and activity fallback still work.
            </>
          ) : (
            <>
              Set <code>VITE_INDEXER_URL</code> and run the indexer to populate
              merchant metrics. Contract state and activity fallback still
              work.
            </>
          )}
        </p>
      ) : !metrics ? (
        <p className="muted">
          No events are attributed to this wallet yet. Create a plan and accept
          a subscription; metrics appear after the indexer catches up.
        </p>
      ) : (
        <>
          <div className="stats analytics-stats">
            <Stat
              label="Settled charges"
              value={metrics.charges.toString()}
              hint={`${metrics.failedCharges} failed`}
            />
            <Stat
              label="Success rate"
              value={formatBps(successRateBps(metrics.charges, metrics.failedCharges))}
            />
            <Stat
              label="Subscriptions"
              value={metrics.subscriptions.toString()}
              hint={`${metrics.topUps} top-ups`}
            />
            <Stat
              label="Cancellations"
              value={metrics.cancellations.toString()}
              hint="including expired grace periods"
            />
          </div>

          <div className="analytics-columns">
            <div>
              <h4>Revenue by token</h4>
              <TokenAmountList
                amounts={metrics.charged}
                decimals={decimals}
                emptyLabel="No settled charges yet."
              />
              <ChartBars
                title="Revenue share"
                items={revenueShares.map((item) => ({
                  label: shortAddress(item.token),
                  value: item.shareBps,
                  display: formatBps(item.shareBps),
                  title: item.token,
                }))}
                emptyLabel="No settled revenue to chart."
              />
              <h4>Refunds by token</h4>
              <TokenAmountList
                amounts={metrics.refunded}
                decimals={decimals}
                emptyLabel="No refunds yet."
              />
              <ChartBars
                title="Refund share"
                items={refundShares.map((item) => ({
                  label: shortAddress(item.token),
                  value: item.shareBps,
                  display: formatBps(item.shareBps),
                  title: item.token,
                }))}
                emptyLabel="No refunds to chart."
              />
            </div>
            <div>
              <SuccessMeter
                succeeded={metrics.charges}
                failed={metrics.failedCharges}
              />
              <h4>By plan</h4>
              {metrics.plans.length === 0 ? (
                <p className="muted">No plan-level events yet.</p>
              ) : (
                <>
                  <ChartBars
                    title="Charges by plan"
                    items={metrics.plans.map((plan) => ({
                      label: `#${plan.planId}`,
                      value: plan.charges,
                      display: `${plan.charges} charge${plan.charges === 1 ? "" : "s"}`,
                    }))}
                    emptyLabel="No plan charges yet."
                  />
                  <table className="metrics-table">
                    <thead>
                      <tr>
                        <th>Plan</th>
                        <th>Subs</th>
                        <th>Charges</th>
                        <th>Failed</th>
                        <th>Settled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.plans.map((plan) => (
                        <tr key={plan.planId}>
                          <td>#{plan.planId}</td>
                          <td>{plan.subscriptions}</td>
                          <td>{plan.charges}</td>
                          <td>{plan.failedCharges}</td>
                          <td title={formatTokenAmounts(plan.charged, decimals)}>
                            {formatTokenAmounts(plan.charged, decimals)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>

          <p className="fineprint">
            Indexer-derived cumulative lifetime counters, not audited on-chain
            accounting. Amounts use the decimals selected above;{" "}
            {payload?.indexedEvents ?? 0} recent events are retained for the
            Activity timeline.
          </p>
        </>
      )}
    </section>
  );
}

function NetworkAnalytics({
  payload,
  live,
  configured,
  decimals,
}: {
  payload: MetricsResponse | null;
  live: boolean;
  configured: boolean;
  decimals: number;
}) {
  if (!live || !payload) {
    return (
      <section className="card analytics-card">
        <div className="card-top">
          <div>
            <span className="eyebrow">Network metrics</span>
            <h3>Public indexer offline</h3>
          </div>
          <span className="pill pill-off">Offline</span>
        </div>
        <p className="muted">
          {configured ? (
            <>
              The indexer did not return a valid metrics payload. Contract reads
              and wallet actions continue to work from RPC.
            </>
          ) : (
            <>
              Set <code>VITE_INDEXER_URL</code> and run the indexer to publish
              network metrics. Contract reads and wallet actions continue to
              work from RPC.
            </>
          )}
        </p>
      </section>
    );
  }

  const network = payload.network;
  const chargedShares = tokenShares(network.charged);
  const eventMix = [
    { label: "Subscriptions", value: network.subscriptions },
    { label: "Charges", value: network.charges },
    { label: "Failed charges", value: network.failedCharges },
    { label: "Cancellations", value: network.cancellations },
    { label: "Plan updates", value: network.planUpdates },
  ];

  return (
    <section className="card analytics-card">
      <div className="card-top">
        <div>
          <span className="eyebrow">Network metrics</span>
          <h3>SubStream activity across all plans</h3>
        </div>
        <div className="analytics-actions">
          <ExportButton payload={payload} scope="network" />
          <span className="pill pill-on">Live</span>
        </div>
      </div>

      <div className="stats analytics-stats">
        <Stat label="Plans created" value={network.plansCreated.toString()} />
        <Stat
          label="Settled charges"
          value={network.charges.toString()}
          hint={`${network.failedCharges} failed`}
        />
        <Stat
          label="Subscriptions"
          value={network.subscriptions.toString()}
          hint={`${network.topUps} top-ups`}
        />
        <Stat
          label="Cancellations"
          value={network.cancellations.toString()}
        />
      </div>

      <div className="analytics-columns">
        <div>
          <SuccessMeter
            succeeded={network.charges}
            failed={network.failedCharges}
          />
          <h4>Settled revenue by token</h4>
          <TokenAmountList
            amounts={network.charged}
            decimals={decimals}
            emptyLabel="No settled charges indexed yet."
          />
          <ChartBars
            title="Revenue share"
            items={chargedShares.map((item) => ({
              label: shortAddress(item.token),
              value: item.shareBps,
              display: formatBps(item.shareBps),
              title: item.token,
            }))}
            emptyLabel="No settled revenue to chart."
          />
        </div>
        <div>
          <ChartBars
            title="Activity mix"
            items={eventMix.map((item) => ({
              label: item.label,
              value: item.value,
              display: item.value.toString(),
            }))}
            emptyLabel="No indexed activity yet."
          />
          <h4>Refunds by token</h4>
          <TokenAmountList
            amounts={network.refunded}
            decimals={decimals}
            emptyLabel="No refunds indexed yet."
          />
        </div>
      </div>

      <p className="fineprint">
        Indexer-derived cumulative lifetime counters. Retained events:{" "}
        {payload.indexedEvents}; last indexed ledger:{" "}
        {payload.lastLedger ?? "—"}; first indexed ledger:{" "}
        {payload.firstIndexedLedger ?? "—"}. Metrics are not audited accounting.
      </p>
    </section>
  );
}

const GUIDE_STEPS: ReadonlyArray<{
  stage: DemoStage;
  title: string;
  description: string;
}> = [
  {
    stage: "connect",
    title: "Connect your wallet",
    description: "Freighter signs each step and reads state from Soroban RPC.",
  },
  {
    stage: "create-plan",
    title: "Create a demo plan",
    description: "Publish a 1-token plan that charges every 10 seconds.",
  },
  {
    stage: "subscribe",
    title: "Subscribe and prepay",
    description: "Escrow two cycles in one signature; terms are snapshotted.",
  },
  {
    stage: "wait",
    title: "Wait for the due date",
    description: "The dashboard tracks the live countdown from contract state.",
  },
  {
    stage: "charge",
    title: "Settle a charge",
    description: "Anyone can trigger the payment once the cycle is due.",
  },
  {
    stage: "complete",
    title: "Cancel and refund",
    description: "Close the subscription and watch unused escrow return.",
  },
];

function GuidedDemo({
  stage,
  plan,
  subscription,
  now,
  decimals,
  explorerBase,
  explorerTx,
  busy,
  onConnect,
  onCreatePlan,
  onSubscribe,
  onCharge,
  onCancel,
  onManage,
  onBrowse,
}: {
  stage: DemoStage;
  plan?: Plan;
  subscription?: Subscription;
  now: bigint;
  decimals: number;
  explorerBase: string;
  explorerTx?: string;
  busy: boolean;
  onConnect: () => void;
  onCreatePlan: () => void;
  onSubscribe: () => void;
  onCharge: () => void;
  onCancel: () => void;
  onManage: () => void;
  onBrowse: () => void;
}) {
  const currentIndex = Math.max(
    0,
    GUIDE_STEPS.findIndex((step) => step.stage === stage),
  );
  const secondsUntilDue =
    subscription && subscription.nextCharge > now
      ? Number(subscription.nextCharge - now)
      : 0;
  const actions: Record<DemoStage, { label: string; run: () => void; off?: boolean }> = {
    connect: { label: "Connect Freighter", run: onConnect },
    "create-plan": { label: "Create demo plan", run: onCreatePlan },
    subscribe: { label: "Subscribe now", run: onSubscribe, off: !plan },
    wait: { label: "Open subscription manager", run: onManage },
    charge: {
      label: "Charge now",
      run: onCharge,
      off: !subscription || !isDue(subscription, now),
    },
    complete: { label: "Browse open plans", run: onBrowse },
  };

  return (
    <div className="guide">
      <div className="card guide-summary">
        <div className="card-top">
          <span className="eyebrow">Current step {currentIndex + 1} of 6</span>
          <span className="pill pill-on">
            {GUIDE_STEPS[currentIndex]?.title ?? "Lifecycle complete"}
          </span>
        </div>
        <h3>{GUIDE_STEPS[currentIndex]?.description ?? "All steps finished."}</h3>
        <p className="muted">
          {stage === "connect" &&
            "Connect Freighter to begin. Testnet funds are required for the 1-token demo plan."}
          {stage === "create-plan" &&
            "The plan uses the token configured for this dApp and stays active for public discovery."}
          {stage === "subscribe" &&
            (plan
              ? `Plan #${plan.id.toString()} is ready: ${formatAmount(plan.amount, decimals)} every ${formatDuration(plan.interval)}.`
              : "Create a demo plan first.")}
          {stage === "wait" &&
            subscription &&
            `Subscription #${subscription.id.toString()} is funded. Next charge in ~${formatDuration(BigInt(secondsUntilDue))}.`}
          {stage === "charge" &&
            subscription &&
            `Subscription #${subscription.id.toString()} is due. ${formatAmount(subscription.balance, decimals)} remains in escrow.`}
          {stage === "complete" &&
            "The demo is complete. The cancellation refunded the unused escrow to your wallet."}
        </p>
        {explorerTx && (
          <a
            className="activity-tx"
            href={`${explorerBase}/${explorerTx}`}
            target="_blank"
            rel="noreferrer"
          >
            View the latest demo transaction ↗
          </a>
        )}
      </div>

      <ol className="guide-steps">
        {GUIDE_STEPS.map((step, index) => {
          const state =
            index < currentIndex
              ? "done"
              : index === currentIndex && stage !== "complete"
                ? "current"
                : "upcoming";
          const action = actions[step.stage];
          return (
            <li className={`guide-step guide-${state}`} key={step.stage}>
              <span className="guide-number" aria-hidden="true">
                {state === "done" ? "✓" : index + 1}
              </span>
              <div className="guide-step-copy">
                <strong>{step.title}</strong>
                <p>{step.description}</p>
                {state === "current" && (
                  <button
                    className="primary"
                    onClick={action.run}
                    disabled={busy || Boolean(action.off)}
                  >
                    {busy ? "Working…" : action.label}
                  </button>
                )}
              </div>
              <span className={`pill ${state === "done" ? "pill-on" : "pill-off"}`}>
                {state === "done"
                  ? "Done"
                  : state === "current"
                    ? "Now"
                    : "Next"}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="fineprint">
        The guided demo creates real testnet transactions. Charges are
        permissionless, and cancelling always refunds the unused escrow.
      </p>
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
  viewer,
  now,
  decimals,
  cycles,
  explorerBase,
  explorerTx,
  onCyclesChange,
  onTopUp,
  onCharge,
  onCancel,
  busy,
}: {
  subscription: Subscription;
  viewer: string;
  now: bigint;
  decimals: number;
  cycles: string;
  explorerBase: string;
  explorerTx?: string;
  onCyclesChange: (value: string) => void;
  onTopUp: () => void;
  onCharge: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const cancelled = subscription.status === SubscriptionStatus.Cancelled;
  const pastDue = subscription.status === SubscriptionStatus.PastDue;
  const due = isDue(subscription, now);
  const isMine = subscription.subscriber === viewer;

  return (
    <article className={`card subscription-card ${cancelled ? "is-muted" : ""}`}>
      <div className="card-top">
        <span className="eyebrow">
          Subscription #{subscription.id.toString()} · plan #
          {subscription.planId.toString()}
        </span>
        <div className="pill-group">
          {due && <span className="pill pill-warn">Due now</span>}
          <span
            className={`pill ${
              cancelled ? "pill-off" : pastDue ? "pill-warn" : "pill-on"
            }`}
          >
            {statusLabel(subscription.status)}
          </span>
        </div>
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

      <p className="sub-meta">
        Subscriber{" "}
        <span title={subscription.subscriber}>
          {isMine ? "you" : shortAddress(subscription.subscriber)}
        </span>
        {explorerTx && (
          <a
            href={`${explorerBase}/${explorerTx}`}
            target="_blank"
            rel="noreferrer"
          >
            View latest transaction ↗
          </a>
        )}
      </p>

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

function MerchantSubscriptionRow({
  subscription,
  viewer,
  now,
  decimals,
  explorerContractBase,
}: {
  subscription: Subscription;
  viewer: string;
  now: bigint;
  decimals: number;
  explorerContractBase: string;
}) {
  return (
    <article className="card merchant-sub-row">
      <div>
        <span className="eyebrow">
          Subscription #{subscription.id.toString()} · plan #
          {subscription.planId.toString()}
        </span>
        <h3>
          {formatAmount(subscription.amount, decimals)} per cycle ·{" "}
          <span title={subscription.subscriber}>
            {subscription.subscriber === viewer
              ? "you"
              : shortAddress(subscription.subscriber)}
          </span>
        </h3>
      </div>
      <dl className="facts">
        <div>
          <dt>Escrow</dt>
          <dd>{formatAmount(subscription.balance, decimals)}</dd>
        </div>
        <div>
          <dt>Next charge</dt>
          <dd>{formatDate(subscription.nextCharge)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{statusLabel(subscription.status)}</dd>
        </div>
      </dl>
      <a
        className="activity-tx"
        href={`${explorerContractBase}/${subscription.token}`}
        target="_blank"
        rel="noreferrer"
      >
        Token on explorer ↗
      </a>
      {isDue(subscription, now) && <span className="pill pill-warn">Due</span>}
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
