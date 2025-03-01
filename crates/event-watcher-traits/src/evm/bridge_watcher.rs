// Copyright 2022 Webb Technologies Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use super::{event_watcher::EventWatcher, *};

/// A Bridge Watcher is a trait for Bridge contracts that not specific for watching events from that contract,
/// instead it watches for commands sent from other event watchers or services, it helps decouple the event watchers
/// from the actual action that should be taken depending on the event.
#[async_trait::async_trait]
pub trait BridgeWatcher: EventWatcher
where
    Self::Store: ProposalStore<Proposal = ()>
        + QueueStore<transaction::eip2718::TypedTransaction, Key = SledQueueKey>
        + QueueStore<BridgeCommand, Key = SledQueueKey>,
{
    /// A method to be called with the [`BridgeCommand`] information to
    /// be executed by the Bridge command handler.
    ///
    /// If this method returned an error, the handler will be considered as failed and will
    /// be retry again, depends on the retry strategy.
    async fn handle_cmd(
        &self,
        store: Arc<Self::Store>,
        contract: &Self::Contract,
        cmd: BridgeCommand,
    ) -> webb_relayer_utils::Result<()>;

    /// Returns a task that should be running in the background
    /// that will watch for all commands
    #[tracing::instrument(
        skip_all,
        fields(
            chain_id = ?client.get_chainid().await,
            address = %contract.address(),
            tag = %Self::TAG,
        ),
    )]
    async fn run(
        &self,
        client: Arc<providers::Provider<providers::Http>>,
        store: Arc<Self::Store>,
        contract: Self::Contract,
        metrics: Arc<metric::Metrics>,
    ) -> webb_relayer_utils::Result<()> {
        let backoff = backoff::backoff::Constant::new(Duration::from_secs(1));
        let task = || async {
            let my_chain_id = client
                .get_chainid()
                .map_err(Into::into)
                .map_err(backoff::Error::transient)
                .await?;
            let bridge_key = BridgeKey::new(my_chain_id);
            let key = SledQueueKey::from_bridge_key(bridge_key);
            loop {
                let result = match store.dequeue_item(key)? {
                    Some(cmd) => {
                        self.handle_cmd(store.clone(), &contract, cmd).await
                    }
                    None => {
                        // yeild back to the runtime, to allow for other tasks
                        // to make progress, instead of this busy loop.
                        tokio::task::yield_now().await;
                        // the small sleep here just in case the runtime decides to
                        // run this task again immediately.
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        continue;
                    }
                };
                match result {
                    Ok(_) => {
                        tracing::debug!(?key, "Handled command successfully");
                        continue;
                    }
                    Err(e) => {
                        tracing::error!("Error while handle_cmd {}", e);
                        // this a transient error, so we will retry again.
                        tracing::warn!("Restarting bridge event watcher ...");
                        // metric for when the bridge watcher enters back off
                        metrics.bridge_watcher_back_off.inc();
                        return Err(backoff::Error::transient(e));
                    }
                }
            }
        };
        // Bridge watcher backoff metric
        metrics.bridge_watcher_back_off.inc();
        backoff::future::retry(backoff, task).await?;
        Ok(())
    }
}
