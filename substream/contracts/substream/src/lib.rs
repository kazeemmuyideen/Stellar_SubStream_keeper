#![no_std]

//! SubStream — recurring payments and subscription escrow on Soroban.
//!
//! The protocol is intentionally small:
//!
//! 1. A merchant creates a `Plan` (token, amount, interval, grace period).
//! 2. A subscriber prepays N cycles into the contract.
//! 3. Anyone (a keeper, the merchant, or the subscriber) can call `charge`.
//!    Due funds move from escrow to the merchant and the schedule advances.
//! 4. If the escrow runs dry, the subscription becomes past due. After the
//!    grace period it can be cancelled and any remaining balance is refunded.
//! 5. A subscriber can cancel at any time and get the unused escrow back.
//!
//! The contract never holds an indefinite allowance and never requires the
//! subscriber to sign once per billing cycle. That makes recurring payments
//! work with Stellar assets (including SAC tokens) without a custom token.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Vec,
};

// ---------------------------------------------------------------------------
// Status / outcome codes
// ---------------------------------------------------------------------------

pub const STATUS_ACTIVE: u32 = 0;
pub const STATUS_PAST_DUE: u32 = 1;
pub const STATUS_CANCELLED: u32 = 2;

pub const OUTCOME_CHARGED: u32 = 0;
pub const OUTCOME_NOT_DUE: u32 = 1;
pub const OUTCOME_INSUFFICIENT_BALANCE: u32 = 2;
pub const OUTCOME_CANCELLED: u32 = 3;
pub const OUTCOME_PLAN_INACTIVE: u32 = 4;

// ~5 second ledgers. 30 day threshold, 90 day extension.
const DAY_IN_LEDGERS: u32 = 17_280;
const PERSISTENT_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const PERSISTENT_EXTEND: u32 = DAY_IN_LEDGERS * 90;
const INSTANCE_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const INSTANCE_EXTEND: u32 = DAY_IN_LEDGERS * 90;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    PlanCount,
    SubscriptionCount,
    Plan(u64),
    Subscription(u64),
    MerchantPlans(Address),
    SubscriberSubscriptions(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    pub merchant: Address,
    pub token: Address,
    pub amount: i128,
    pub interval: u64,
    pub grace_period: u64,
    pub active: bool,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub plan_id: u64,
    pub subscriber: Address,
    /// Amount and interval are snapshotted at subscribe time so a merchant
    /// cannot unilaterally change the terms of an existing subscription.
    pub amount: i128,
    pub interval: u64,
    pub grace_period: u64,
    pub balance: i128,
    pub next_charge: u64,
    pub status: u32,
    pub cycles_paid: u32,
    pub started_at: u64,
    pub last_charged_at: u64,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    PlanNotFound = 1,
    SubscriptionNotFound = 2,
    InvalidAmount = 3,
    InvalidInterval = 4,
    InvalidCycles = 5,
    PlanInactive = 6,
    AlreadyCancelled = 7,
    Unauthorized = 8,
    Overflow = 9,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent(topics = ["plan_new"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanCreated {
    #[topic]
    pub plan_id: u64,
    pub merchant: Address,
    pub token: Address,
    pub amount: i128,
    pub interval: u64,
    pub grace_period: u64,
}

#[contractevent(topics = ["plan_upd"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanUpdated {
    #[topic]
    pub plan_id: u64,
    pub amount: i128,
    pub interval: u64,
    pub active: bool,
}

#[contractevent(topics = ["subscribe"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscribed {
    #[topic]
    pub subscription_id: u64,
    pub plan_id: u64,
    pub subscriber: Address,
    pub deposit: i128,
    pub next_charge: u64,
}

#[contractevent(topics = ["topped_up"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToppedUp {
    #[topic]
    pub subscription_id: u64,
    pub subscriber: Address,
    pub amount: i128,
    pub balance: i128,
}

#[contractevent(topics = ["charged"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Charged {
    #[topic]
    pub subscription_id: u64,
    pub plan_id: u64,
    pub subscriber: Address,
    pub merchant: Address,
    pub amount: i128,
    pub next_charge: u64,
}

#[contractevent(topics = ["pay_fail"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentFailed {
    #[topic]
    pub subscription_id: u64,
    pub plan_id: u64,
    pub subscriber: Address,
    pub balance: i128,
}

#[contractevent(topics = ["cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cancelled {
    #[topic]
    pub subscription_id: u64,
    pub subscriber: Address,
    pub refund: i128,
    /// 0 = subscriber, 1 = grace period expired, 2 = merchant.
    pub reason: u32,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct SubStreamContract;

#[contractimpl]
impl SubStreamContract {
    /// Create a reusable billing plan. Returns the new plan id.
    pub fn create_plan(
        env: Env,
        merchant: Address,
        token: Address,
        amount: i128,
        interval: u64,
        grace_period: u64,
    ) -> Result<u64, Error> {
        merchant.require_auth();
        validate_terms(amount, interval)?;

        let plan_id = next_id(&env, DataKey::PlanCount);
        let now = env.ledger().timestamp();

        let plan = Plan {
            merchant: merchant.clone(),
            token: token.clone(),
            amount,
            interval,
            grace_period,
            active: true,
            created_at: now,
        };

        put_plan(&env, plan_id, &plan);
        push_index(&env, DataKey::MerchantPlans(merchant.clone()), plan_id);

        PlanCreated {
            plan_id,
            merchant,
            token,
            amount,
            interval,
            grace_period,
        }
        .publish(&env);

        Ok(plan_id)
    }

    /// Update a plan. Only affects subscriptions created after the update.
    pub fn update_plan(
        env: Env,
        merchant: Address,
        plan_id: u64,
        amount: i128,
        interval: u64,
        grace_period: u64,
        active: bool,
    ) -> Result<(), Error> {
        merchant.require_auth();
        validate_terms(amount, interval)?;

        let mut plan = get_plan_internal(&env, plan_id)?;
        if plan.merchant != merchant {
            return Err(Error::Unauthorized);
        }

        plan.amount = amount;
        plan.interval = interval;
        plan.grace_period = grace_period;
        plan.active = active;
        put_plan(&env, plan_id, &plan);

        PlanUpdated {
            plan_id,
            amount,
            interval,
            active,
        }
        .publish(&env);

        Ok(())
    }

    /// Prepay `cycles_prepaid` billing cycles. The subscriber must hold enough
    /// of the plan token; the deposit is held in escrow by this contract.
    pub fn subscribe(
        env: Env,
        subscriber: Address,
        plan_id: u64,
        cycles_prepaid: u32,
    ) -> Result<u64, Error> {
        subscriber.require_auth();

        let plan = get_plan_internal(&env, plan_id)?;
        if !plan.active {
            return Err(Error::PlanInactive);
        }
        if cycles_prepaid == 0 {
            return Err(Error::InvalidCycles);
        }

        let deposit = plan
            .amount
            .checked_mul(cycles_prepaid as i128)
            .ok_or(Error::Overflow)?;

        token::Client::new(&env, &plan.token).transfer(
            &subscriber,
            env.current_contract_address(),
            &deposit,
        );

        let subscription_id = next_id(&env, DataKey::SubscriptionCount);
        let now = env.ledger().timestamp();
        let next_charge = now.checked_add(plan.interval).ok_or(Error::Overflow)?;

        let subscription = Subscription {
            plan_id,
            subscriber: subscriber.clone(),
            amount: plan.amount,
            interval: plan.interval,
            grace_period: plan.grace_period,
            balance: deposit,
            next_charge,
            status: STATUS_ACTIVE,
            cycles_paid: 0,
            started_at: now,
            last_charged_at: 0,
        };

        put_subscription(&env, subscription_id, &subscription);
        push_index(
            &env,
            DataKey::SubscriberSubscriptions(subscriber.clone()),
            subscription_id,
        );

        Subscribed {
            subscription_id,
            plan_id,
            subscriber,
            deposit,
            next_charge,
        }
        .publish(&env);

        Ok(subscription_id)
    }

    /// Add more escrow to an existing subscription.
    pub fn top_up(
        env: Env,
        subscriber: Address,
        subscription_id: u64,
        cycles: u32,
    ) -> Result<i128, Error> {
        subscriber.require_auth();

        let mut subscription = get_subscription_internal(&env, subscription_id)?;
        if subscription.subscriber != subscriber {
            return Err(Error::Unauthorized);
        }
        if subscription.status == STATUS_CANCELLED {
            return Err(Error::AlreadyCancelled);
        }
        if cycles == 0 {
            return Err(Error::InvalidCycles);
        }

        let plan = get_plan_internal(&env, subscription.plan_id)?;

        // A past-due subscription has until next_charge + grace_period to be
        // restored. Finalize the expiry here so a late top-up cannot revive a
        // subscription that charge() would already have cancelled.
        if subscription.status == STATUS_PAST_DUE
            && env.ledger().timestamp()
                > subscription
                    .next_charge
                    .saturating_add(subscription.grace_period)
        {
            cancel_expired(&env, subscription_id, &mut subscription, &plan.token);
            return Ok(subscription.balance);
        }

        if !plan.active {
            return Err(Error::PlanInactive);
        }

        let amount = subscription
            .amount
            .checked_mul(cycles as i128)
            .ok_or(Error::Overflow)?;

        token::Client::new(&env, &plan.token).transfer(
            &subscriber,
            env.current_contract_address(),
            &amount,
        );

        subscription.balance = subscription
            .balance
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        if subscription.balance >= subscription.amount {
            subscription.status = STATUS_ACTIVE;
        }
        put_subscription(&env, subscription_id, &subscription);

        ToppedUp {
            subscription_id,
            subscriber,
            amount,
            balance: subscription.balance,
        }
        .publish(&env);

        Ok(subscription.balance)
    }

    /// Charge one due cycle. Permissionless: a keeper, merchant, or subscriber
    /// can trigger it. Returns an outcome code (see OUTCOME_* constants).
    pub fn charge(env: Env, subscription_id: u64) -> Result<u32, Error> {
        let mut subscription = get_subscription_internal(&env, subscription_id)?;

        if subscription.status == STATUS_CANCELLED {
            return Ok(OUTCOME_CANCELLED);
        }

        let plan = get_plan_internal(&env, subscription.plan_id)?;
        let now = env.ledger().timestamp();

        if now < subscription.next_charge {
            return Ok(OUTCOME_NOT_DUE);
        }

        if !plan.active {
            return Ok(OUTCOME_PLAN_INACTIVE);
        }

        if subscription.balance < subscription.amount {
            let deadline = subscription
                .next_charge
                .saturating_add(subscription.grace_period);

            if now > deadline {
                cancel_expired(&env, subscription_id, &mut subscription, &plan.token);
                return Ok(OUTCOME_CANCELLED);
            }

            subscription.status = STATUS_PAST_DUE;
            put_subscription(&env, subscription_id, &subscription);

            PaymentFailed {
                subscription_id,
                plan_id: subscription.plan_id,
                subscriber: subscription.subscriber.clone(),
                balance: subscription.balance,
            }
            .publish(&env);

            return Ok(OUTCOME_INSUFFICIENT_BALANCE);
        }

        let merchant = plan.merchant.clone();
        token::Client::new(&env, &plan.token).transfer(
            &env.current_contract_address(),
            &merchant,
            &subscription.amount,
        );

        subscription.balance -= subscription.amount;
        subscription.cycles_paid = subscription.cycles_paid.saturating_add(1);
        subscription.last_charged_at = now;
        subscription.next_charge = now.saturating_add(subscription.interval);
        subscription.status = STATUS_ACTIVE;
        put_subscription(&env, subscription_id, &subscription);

        Charged {
            subscription_id,
            plan_id: subscription.plan_id,
            subscriber: subscription.subscriber.clone(),
            merchant,
            amount: subscription.amount,
            next_charge: subscription.next_charge,
        }
        .publish(&env);

        Ok(OUTCOME_CHARGED)
    }

    /// Cancel a subscription and refund the unused escrow to the subscriber.
    pub fn cancel(env: Env, subscriber: Address, subscription_id: u64) -> Result<i128, Error> {
        subscriber.require_auth();

        let mut subscription = get_subscription_internal(&env, subscription_id)?;
        if subscription.subscriber != subscriber {
            return Err(Error::Unauthorized);
        }
        if subscription.status == STATUS_CANCELLED {
            return Err(Error::AlreadyCancelled);
        }

        let plan = get_plan_internal(&env, subscription.plan_id)?;
        let refund = subscription.balance;

        if refund > 0 {
            token::Client::new(&env, &plan.token).transfer(
                &env.current_contract_address(),
                &subscriber,
                &refund,
            );
        }

        subscription.balance = 0;
        subscription.status = STATUS_CANCELLED;
        put_subscription(&env, subscription_id, &subscription);

        Cancelled {
            subscription_id,
            subscriber,
            refund,
            reason: 0, // subscriber
        }
        .publish(&env);

        Ok(refund)
    }

    /// Merchant-side cancellation for a paused plan or a past-due subscription.
    /// The remaining escrow always goes back to the subscriber.
    pub fn cancel_by_merchant(
        env: Env,
        merchant: Address,
        subscription_id: u64,
    ) -> Result<i128, Error> {
        merchant.require_auth();

        let mut subscription = get_subscription_internal(&env, subscription_id)?;
        let plan = get_plan_internal(&env, subscription.plan_id)?;

        if plan.merchant != merchant {
            return Err(Error::Unauthorized);
        }
        if subscription.status == STATUS_CANCELLED {
            return Err(Error::AlreadyCancelled);
        }
        if plan.active && subscription.status != STATUS_PAST_DUE {
            return Err(Error::Unauthorized);
        }

        let refund = subscription.balance;
        if refund > 0 {
            token::Client::new(&env, &plan.token).transfer(
                &env.current_contract_address(),
                &subscription.subscriber,
                &refund,
            );
        }

        subscription.balance = 0;
        subscription.status = STATUS_CANCELLED;
        put_subscription(&env, subscription_id, &subscription);

        Cancelled {
            subscription_id,
            subscriber: subscription.subscriber.clone(),
            refund,
            reason: 2, // merchant
        }
        .publish(&env);

        Ok(refund)
    }

    // -----------------------------------------------------------------------
    // Read-only helpers
    // -----------------------------------------------------------------------

    pub fn get_plan(env: Env, plan_id: u64) -> Result<Plan, Error> {
        get_plan_internal(&env, plan_id)
    }

    pub fn get_subscription(env: Env, subscription_id: u64) -> Result<Subscription, Error> {
        get_subscription_internal(&env, subscription_id)
    }

    pub fn get_plan_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::PlanCount)
            .unwrap_or(0)
    }

    pub fn get_subscription_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::SubscriptionCount)
            .unwrap_or(0)
    }

    pub fn get_merchant_plans(env: Env, merchant: Address) -> Vec<u64> {
        get_index(&env, DataKey::MerchantPlans(merchant))
    }

    pub fn get_subscriber_subscriptions(env: Env, subscriber: Address) -> Vec<u64> {
        get_index(&env, DataKey::SubscriberSubscriptions(subscriber))
    }

    pub fn is_due(env: Env, subscription_id: u64) -> Result<bool, Error> {
        let subscription = get_subscription_internal(&env, subscription_id)?;
        Ok(subscription.status != STATUS_CANCELLED
            && env.ledger().timestamp() >= subscription.next_charge)
    }

    pub fn quote(env: Env, plan_id: u64, cycles: u32) -> Result<i128, Error> {
        let plan = get_plan_internal(&env, plan_id)?;
        plan.amount
            .checked_mul(cycles as i128)
            .ok_or(Error::Overflow)
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn validate_terms(amount: i128, interval: u64) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if interval == 0 {
        return Err(Error::InvalidInterval);
    }
    Ok(())
}

fn next_id(env: &Env, key: DataKey) -> u64 {
    let current: u64 = env.storage().instance().get(&key).unwrap_or(0);
    let next = current.saturating_add(1);
    env.storage().instance().set(&key, &next);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_EXTEND);
    next
}

fn put_plan(env: &Env, plan_id: u64, plan: &Plan) {
    let key = DataKey::Plan(plan_id);
    env.storage().persistent().set(&key, plan);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_EXTEND);
}

fn get_plan_internal(env: &Env, plan_id: u64) -> Result<Plan, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Plan(plan_id))
        .ok_or(Error::PlanNotFound)
}

/// Cancel a subscription whose grace period has expired and refund any escrow
/// left in the contract. Shared by `charge` and `top_up` so both entry points
/// enforce the same deadline.
fn cancel_expired(
    env: &Env,
    subscription_id: u64,
    subscription: &mut Subscription,
    token: &Address,
) {
    let refund = subscription.balance;
    if refund > 0 {
        token::Client::new(env, token).transfer(
            &env.current_contract_address(),
            &subscription.subscriber,
            &refund,
        );
    }

    subscription.balance = 0;
    subscription.status = STATUS_CANCELLED;
    put_subscription(env, subscription_id, subscription);

    Cancelled {
        subscription_id,
        subscriber: subscription.subscriber.clone(),
        refund,
        reason: 1, // grace period expired
    }
    .publish(env);
}

fn put_subscription(env: &Env, subscription_id: u64, subscription: &Subscription) {
    let key = DataKey::Subscription(subscription_id);
    env.storage().persistent().set(&key, subscription);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_EXTEND);
}

fn get_subscription_internal(env: &Env, subscription_id: u64) -> Result<Subscription, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Subscription(subscription_id))
        .ok_or(Error::SubscriptionNotFound)
}

fn get_index(env: &Env, key: DataKey) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env))
}

fn push_index(env: &Env, key: DataKey, id: u64) {
    let mut ids = get_index(env, key.clone());
    ids.push_back(id);
    env.storage().persistent().set(&key, &ids);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_EXTEND);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test;
