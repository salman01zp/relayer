use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use webb::evm::ethereum_types::{Address, Secret, U256};

const fn default_port() -> u16 {
    9955
}

const fn enable_leaves_watcher_default() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub struct WebbRelayerConfig {
    /// WebSocket Server Port number
    ///
    /// default to 9955
    #[serde(default = "default_port", skip_serializing)]
    pub port: u16,
    /// EVM based networks and the configuration.
    ///
    /// a map between chain name and its configuration.
    pub evm: HashMap<String, ChainConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub struct ChainConfig {
    /// Http(s) Endpoint for quick Req/Res
    #[serde(skip_serializing)]
    pub http_endpoint: url::Url,
    /// Websocket Endpoint for long living connections
    #[serde(skip_serializing)]
    pub ws_endpoint: url::Url,
    /// Block Explorer for this chain.
    ///
    /// Optional, and only used for printing a clickable links
    /// for transactions and contracts.
    #[serde(skip_serializing)]
    pub explorer: Option<url::Url>,
    /// chain specific id.
    #[serde(rename(serialize = "chainId"))]
    pub chain_id: u64,
    /// The Private Key of this account on this network
    /// the format is more dynamic here:
    /// 1. if it starts with '0x' then this would be raw (64 bytes) hex encoded
    ///    private key.
    ///    Example: 0x8917174396171783496173419137618235192359106130478137647163400318
    ///
    /// 2. if it starts with '$' then it would be considered as an Enviroment variable
    ///    of a hex-encoded private key.
    ///   Example: $HARMONY_PRIVATE_KEY
    ///
    /// 3. if it starts with '> ' then it would be considered as a command that
    ///   the relayer would execute and the output of this command would be the
    ///   hex encoded private key.
    ///   Example: > pass harmony-privatekey
    ///
    /// 4. if it doesn't contains special characters and has 12 or 24 words in it
    ///   then we should process it as a mnemonic string: 'word two three four ...'
    #[serde(skip_serializing)]
    pub private_key: PrivateKey,
    /// INTERNAL: got updated with the account address of the private key.
    #[serde(skip_deserializing)]
    pub account: Option<Address>,
    /// Supported contracts over this chain.
    pub contracts: Vec<Contract>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct EventsWatcherConfig {
    #[serde(default = "enable_leaves_watcher_default")]
    /// if it is enabled for this chain or not.
    pub enabled: bool,
    /// Polling interval in milliseconds
    #[serde(rename(serialize = "pollingInterval"))]
    pub polling_interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct AnchorWithdrawConfig {
    /// The fee percentage that your account will receive when you relay a transaction
    /// over this chain.
    #[serde(rename(serialize = "withdrawFeePercentage"))]
    pub withdraw_fee_percentage: f64,
    /// A hex value of the gaslimit when doing a withdraw relay transaction on this chain.
    #[serde(skip_serializing)]
    pub withdraw_gaslimit: U256,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct LinkedAnchorConfig {
    /// The Chain name where this anchor belongs to.
    /// and it is case-insensitive.
    pub chain: String,
    /// The Anchor2 Contract Address.
    pub address: Address,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "contract")]
pub enum Contract {
    Anchor(AnchorContractConfig),
    Anchor2(Anchor2ContractConfig),
    Bridge(BridgeContractConfig),
    GovernanceBravoDelegate(GovernanceBravoDelegateContractConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct CommonContractConfig {
    /// The address of this contract on this chain.
    pub address: Address,
    /// the block number where this contract got deployed at.
    #[serde(rename(serialize = "deployedAt"))]
    pub deployed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct AnchorContractConfig {
    #[serde(flatten)]
    pub common: CommonContractConfig,
    /// Controls the events watcher
    #[serde(rename(serialize = "eventsWatcher"))]
    pub events_watcher: EventsWatcherConfig,
    /// The size of this contract
    pub size: f64,
    /// Anchor withdraw configuration.
    #[serde(flatten)]
    pub withdraw_config: AnchorWithdrawConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Anchor2ContractConfig {
    #[serde(flatten)]
    pub common: CommonContractConfig,
    /// Controls the events watcher
    #[serde(rename(serialize = "eventsWatcher"))]
    pub events_watcher: EventsWatcherConfig,
    /// The size of this contract
    pub size: f64,
    /// Anchor withdraw configuration.
    #[serde(flatten)]
    pub withdraw_config: AnchorWithdrawConfig,
    /// A List of linked Anchor2 Contracts (on other chains) to this contract.
    #[serde(rename(serialize = "linkedAnchors"))]
    pub linked_anchors: Vec<LinkedAnchorConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct BridgeContractConfig {
    #[serde(flatten)]
    pub common: CommonContractConfig,
    /// Controls the events watcher
    #[serde(rename(serialize = "eventsWatcher"))]
    pub events_watcher: EventsWatcherConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct GovernanceBravoDelegateContractConfig {
    #[serde(flatten)]
    pub common: CommonContractConfig,
    // TODO(@shekohex): add more fields here...
}

#[derive(Debug, Clone)]
pub struct PrivateKey(Secret);

impl std::ops::Deref for PrivateKey {
    type Target = Secret;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PrivateKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct PrivateKeyVistor;
        impl<'de> serde::de::Visitor<'de> for PrivateKeyVistor {
            type Value = Secret;

            fn expecting(
                &self,
                formatter: &mut std::fmt::Formatter,
            ) -> std::fmt::Result {
                formatter.write_str(
                    "hex string or an env var containing a hex string in it",
                )
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value.starts_with("0x") {
                    // hex value
                    Secret::from_str(value)
                        .map_err(|e| serde::de::Error::custom(e.to_string()))
                } else if value.starts_with('$') {
                    // env
                    let var = value.strip_prefix('$').unwrap_or(value);
                    let val = std::env::var(var)
                        .map_err(|e| serde::de::Error::custom(e.to_string()))?;
                    Secret::from_str(&val)
                        .map_err(|e| serde::de::Error::custom(e.to_string()))
                } else if value.starts_with('>') {
                    todo!("Implement command execution to extract the private key")
                } else {
                    todo!("Parse the string as mnemonic seed.")
                }
            }
        }

        let secret = deserializer.deserialize_str(PrivateKeyVistor)?;
        Ok(Self(secret))
    }
}

pub fn load<P: AsRef<Path>>(path: P) -> anyhow::Result<WebbRelayerConfig> {
    let mut cfg = config::Config::new();
    let base = path.as_ref().display().to_string();
    cfg.merge(config::File::with_name(&base))?
        .merge(config::Environment::with_prefix("WEBB"))?;
    postloading_process(cfg.try_into()?)
}

fn postloading_process(
    mut config: WebbRelayerConfig,
) -> anyhow::Result<WebbRelayerConfig> {
    tracing::trace!("Checking configration sanity ...");
    // make all chain names lower case
    // 1. drain everything.
    let old_evm: HashMap<_, _> = config.evm.drain().collect();
    // 2. insert them again, as lowercased.
    for (k, v) in old_evm {
        config.evm.insert(k.to_lowercase(), v);
    }
    // check that all required chains are already present in the config.
    for (chain_name, chain_config) in &config.evm {
        let anchors2 = chain_config.contracts.iter().filter_map(|c| match c {
            Contract::Anchor2(cfg) => Some(cfg),
            _ => None,
        });
        for anchor2 in anchors2 {
            for linked_anchor in &anchor2.linked_anchors {
                let chain = linked_anchor.chain.to_lowercase();
                let chain_defined = config.evm.contains_key(&chain);
                if !chain_defined {
                    tracing::warn!("!!WARNING!!: chain {} is not defined in the config.
                        which is required by the Anchor2 Contract ({}) defined on {} chain.
                        Please, define it manually, to allow the relayer to work properly.",
                        chain,
                        anchor2.common.address,
                        chain_name
                    );
                }
            }
        }
    }
    Ok(config)
}
