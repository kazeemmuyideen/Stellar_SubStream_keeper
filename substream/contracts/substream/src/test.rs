use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

const START: u64 = 1_700_000_000;
const DAY: u64 = 86_400;
const GRACE: u64 = 3_600;

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(SubStreamContract, ());
    let merchant = Address::generate(&env);
    let subscriber = Address::generate(&env);
    let admin = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = sac.address();
    StellarAssetClient::new(&env, &token).mint(&subscriber, &100_000i128);

    env.ledger().set_timestamp(START);
    (env, contract_id, merchant, subscriber, token)
}

#[test]
fn creates_plan_and_subscription() {
    let (env, contract_id, merchant, subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    let plan_id = client.create_plan(&merchant, &token, &1_000i128, &DAY, &GRACE);
    assert_eq!(plan_id, 1);
    assert_eq!(client.get_plan_count(), 1);

    let plan = client.get_plan(&plan_id);
    assert_eq!(plan.merchant, merchant);
    assert_eq!(plan.token, token);
    assert_eq!(plan.amount, 1_000);
    assert_eq!(plan.interval, DAY);
    assert_eq!(plan.grace_period, GRACE);
    assert!(plan.active);
    assert_eq!(plan.created_at, START);

    let subscription_id = client.subscribe(&subscriber, &plan_id, &3u32);
    assert_eq!(subscription_id, 1);
    assert_eq!(client.get_subscription_count(), 1);

    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.plan_id, plan_id);
    assert_eq!(subscription.amount, 1_000);
    assert_eq!(subscription.interval, DAY);
    assert_eq!(subscription.grace_period, GRACE);
    assert_eq!(subscription.balance, 3_000);
    assert_eq!(subscription.next_charge, START + DAY);
    assert_eq!(subscription.status, STATUS_ACTIVE);
    assert_eq!(subscription.cycles_paid, 0);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&subscriber), 97_000);
    assert_eq!(token_client.balance(&contract_id), 3_000);

    let merchant_plans = client.get_merchant_plans(&merchant);
    assert_eq!(merchant_plans.len(), 1);
    assert_eq!(merchant_plans.get(0), Some(plan_id));

    let subscriptions = client.get_subscriber_subscriptions(&subscriber);
    assert_eq!(subscriptions.len(), 1);
    assert_eq!(subscriptions.get(0), Some(subscription_id));
}

#[test]
fn charges_on_schedule_and_advances_next_charge() {
    let (env, contract_id, merchant, subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    let plan_id = client.create_plan(&merchant, &token, &1_000i128, &DAY, &GRACE);
    let subscription_id = client.subscribe(&subscriber, &plan_id, &2u32);

    assert_eq!(client.charge(&subscription_id), OUTCOME_NOT_DUE);

    env.ledger().set_timestamp(START + DAY);
    assert_eq!(client.charge(&subscription_id), OUTCOME_CHARGED);

    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.balance, 1_000);
    assert_eq!(subscription.cycles_paid, 1);
    assert_eq!(subscription.next_charge, START + (DAY * 2));
    assert_eq!(TokenClient::new(&env, &token).balance(&merchant), 1_000);

    env.ledger().set_timestamp(START + (DAY * 2));
    assert_eq!(client.charge(&subscription_id), OUTCOME_CHARGED);

    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.balance, 0);
    assert_eq!(subscription.cycles_paid, 2);
    assert_eq!(TokenClient::new(&env, &token).balance(&merchant), 2_000);
}

#[test]
fn top_up_and_cancel_refunds_unused_escrow() {
    let (env, contract_id, merchant, subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    let plan_id = client.create_plan(&merchant, &token, &1_000i128, &DAY, &GRACE);
    let subscription_id = client.subscribe(&subscriber, &plan_id, &1u32);

    env.ledger().set_timestamp(START + DAY);
    assert_eq!(client.charge(&subscription_id), OUTCOME_CHARGED);

    let balance = client.top_up(&subscriber, &subscription_id, &2u32);
    assert_eq!(balance, 2_000);
    assert_eq!(TokenClient::new(&env, &token).balance(&subscriber), 97_000);

    let refund = client.cancel(&subscriber, &subscription_id);
    assert_eq!(refund, 2_000);
    assert_eq!(TokenClient::new(&env, &token).balance(&subscriber), 99_000);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);

    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.status, STATUS_CANCELLED);
    assert_eq!(subscription.balance, 0);
}

#[test]
fn insufficient_balance_marks_past_due_then_expires() {
    let (env, contract_id, merchant, subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    let plan_id = client.create_plan(&merchant, &token, &1_000i128, &DAY, &GRACE);
    let subscription_id = client.subscribe(&subscriber, &plan_id, &1u32);

    env.ledger().set_timestamp(START + DAY);
    assert_eq!(client.charge(&subscription_id), OUTCOME_CHARGED);

    env.ledger().set_timestamp(START + (DAY * 2));
    assert_eq!(
        client.charge(&subscription_id),
        OUTCOME_INSUFFICIENT_BALANCE
    );
    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.status, STATUS_PAST_DUE);

    // Still inside the grace window, so the subscription stays past due.
    env.ledger().set_timestamp(START + (DAY * 2) + GRACE);
    assert_eq!(
        client.charge(&subscription_id),
        OUTCOME_INSUFFICIENT_BALANCE
    );

    // One second past the grace window: cancel and refund what is left.
    env.ledger().set_timestamp(START + (DAY * 2) + GRACE + 1);
    assert_eq!(client.charge(&subscription_id), OUTCOME_CANCELLED);
    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.status, STATUS_CANCELLED);
    assert_eq!(subscription.balance, 0);
}

#[test]
fn plan_updates_only_affect_new_subscriptions() {
    let (env, contract_id, merchant, subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    let plan_id = client.create_plan(&merchant, &token, &1_000i128, &DAY, &GRACE);
    let subscription_id = client.subscribe(&subscriber, &plan_id, &2u32);

    client.update_plan(
        &merchant,
        &plan_id,
        &2_000i128,
        &(DAY / 2),
        &1_800u64,
        &true,
    );

    env.ledger().set_timestamp(START + DAY);
    assert_eq!(client.charge(&subscription_id), OUTCOME_CHARGED);

    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.amount, 1_000);
    assert_eq!(subscription.interval, DAY);
    assert_eq!(subscription.balance, 1_000);
    assert_eq!(TokenClient::new(&env, &token).balance(&merchant), 1_000);
}

#[test]
fn paused_plan_blocks_charge_but_allows_refund() {
    let (env, contract_id, merchant, subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    let plan_id = client.create_plan(&merchant, &token, &1_000i128, &DAY, &GRACE);
    let subscription_id = client.subscribe(&subscriber, &plan_id, &2u32);

    client.update_plan(&merchant, &plan_id, &1_000i128, &DAY, &GRACE, &false);

    env.ledger().set_timestamp(START + DAY);
    assert_eq!(client.charge(&subscription_id), OUTCOME_PLAN_INACTIVE);

    assert_eq!(client.cancel(&subscriber, &subscription_id), 2_000);
    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.status, STATUS_CANCELLED);
}

#[test]
fn merchant_can_cancel_past_due_subscription() {
    let (env, contract_id, merchant, subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    let plan_id = client.create_plan(&merchant, &token, &1_000i128, &DAY, &GRACE);
    let subscription_id = client.subscribe(&subscriber, &plan_id, &1u32);

    env.ledger().set_timestamp(START + DAY);
    assert_eq!(client.charge(&subscription_id), OUTCOME_CHARGED);

    env.ledger().set_timestamp(START + (DAY * 2));
    assert_eq!(
        client.charge(&subscription_id),
        OUTCOME_INSUFFICIENT_BALANCE
    );

    assert_eq!(client.cancel_by_merchant(&merchant, &subscription_id,), 0);
    let subscription = client.get_subscription(&subscription_id);
    assert_eq!(subscription.status, STATUS_CANCELLED);
}

#[test]
fn rejects_invalid_plan_terms() {
    let (env, contract_id, merchant, _subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    assert!(client
        .try_create_plan(&merchant, &token, &0i128, &DAY, &GRACE)
        .is_err());
    assert!(client
        .try_create_plan(&merchant, &token, &1_000i128, &0u64, &GRACE)
        .is_err());
}

#[test]
fn only_merchant_can_update_plan() {
    let (env, contract_id, merchant, _subscriber, token) = setup();
    let client = SubStreamContractClient::new(&env, &contract_id);

    let plan_id = client.create_plan(&merchant, &token, &1_000i128, &DAY, &GRACE);
    let other = Address::generate(&env);

    assert!(client
        .try_update_plan(&other, &plan_id, &2_000i128, &DAY, &GRACE, &true)
        .is_err());
}
