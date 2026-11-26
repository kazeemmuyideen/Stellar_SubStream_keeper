//! Deterministic property-style tests for the charge state machine.
//!
//! These are not fuzz targets: they replay seeded action sequences so CI stays
//! fast and reproducible while still covering many orderings of charge,
//! top-up, plan changes, cancellation, and time advances.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

const START: u64 = 1_700_000_000;
const DAY: u64 = 86_400;
const HOUR: u64 = 3_600;
const AMOUNT: i128 = 100;
const INITIAL_SUPPLY: i128 = 100_000;

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

struct Context<'a> {
    contract_id: &'a Address,
    merchant: &'a Address,
    subscriber: &'a Address,
    subscription_id: u64,
    previous_cycles: u32,
    previous_next_charge: u64,
}

fn assert_invariants(
    client: &SubStreamContractClient<'_>,
    token: &TokenClient<'_>,
    context: &mut Context<'_>,
) {
    let subscription_id = context.subscription_id;
    let subscription = client.get_subscription(&subscription_id);
    assert!(subscription.balance >= 0, "escrow balance went negative");
    assert!(
        subscription.cycles_paid >= context.previous_cycles,
        "cycles_paid regressed"
    );
    assert!(
        subscription.next_charge >= context.previous_next_charge,
        "next_charge regressed"
    );

    if subscription.status == STATUS_CANCELLED {
        assert_eq!(subscription.balance, 0, "cancelled escrow was not refunded");
        let outcome = client.charge(&subscription_id);
        assert_eq!(outcome, OUTCOME_CANCELLED, "cancelled subscription charged");
    } else {
        assert_eq!(
            token.balance(context.contract_id),
            subscription.balance,
            "contract escrow diverged from subscription balance"
        );
    }

    assert_eq!(
        token.balance(context.merchant),
        i128::from(subscription.cycles_paid) * AMOUNT,
        "merchant payout diverged from cycles_paid"
    );
    assert_eq!(
        token.balance(context.contract_id)
            + token.balance(context.merchant)
            + token.balance(context.subscriber),
        INITIAL_SUPPLY,
        "token conservation failed"
    );

    context.previous_cycles = subscription.cycles_paid;
    context.previous_next_charge = subscription.next_charge;
}

#[test]
fn randomized_sequences_preserve_escrow_invariants() {
    for seed in 1..=16u64 {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(SubStreamContract, ());
        let merchant = Address::generate(&env);
        let subscriber = Address::generate(&env);
        let admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin);
        let token_address = sac.address();
        StellarAssetClient::new(&env, &token_address).mint(&subscriber, &INITIAL_SUPPLY);
        env.ledger().set_timestamp(START);

        let client = SubStreamContractClient::new(&env, &contract_id);
        let token = TokenClient::new(&env, &token_address);
        let plan_id = client.create_plan(&merchant, &token_address, &AMOUNT, &DAY, &HOUR);
        let cycles = 1 + (Rng::new(seed).below(5)) as u32;
        let subscription_id = client.subscribe(&subscriber, &plan_id, &cycles);

        let mut rng = Rng::new(seed ^ 0x9e37_79b9_7f4a_7c15);
        let mut now = START;
        let mut context = Context {
            contract_id: &contract_id,
            merchant: &merchant,
            subscriber: &subscriber,
            subscription_id,
            previous_cycles: 0,
            previous_next_charge: client.get_subscription(&subscription_id).next_charge,
        };

        for _ in 0..30 {
            now += rng.below(DAY / 2);
            env.ledger().set_timestamp(now);

            match rng.below(10) {
                0..=4 => {
                    client.charge(&subscription_id);
                }
                5..=7 => {
                    let top_up_cycles = 1 + rng.below(2) as u32;
                    let _ = client.try_top_up(&subscriber, &subscription_id, &top_up_cycles);
                }
                8 => {
                    let active = rng.below(2) == 0;
                    client.update_plan(&merchant, &plan_id, &AMOUNT, &DAY, &HOUR, &active);
                }
                _ => {
                    let _ = client.try_cancel(&subscriber, &subscription_id);
                }
            }

            assert_invariants(&client, &token, &mut context);
        }

        // A cancelled subscription is final, even after long time advances.
        let _ = client.try_cancel(&subscriber, &subscription_id);
        env.ledger().set_timestamp(now + 10 * DAY);
        assert_eq!(client.charge(&subscription_id), OUTCOME_CANCELLED);
        assert_eq!(
            client.get_subscription(&subscription_id).status,
            STATUS_CANCELLED
        );
    }
}
