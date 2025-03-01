/*
 * Copyright 2022 Webb Technologies Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
import fs from 'fs';
import { ethers, Wallet } from 'ethers';
import { Utility, VBridge } from '@webb-tools/protocol-solidity';
import { DeployerConfig, GovernorConfig } from '@webb-tools/interfaces';
import { MintableToken } from '@webb-tools/tokens';
import { GovernedTokenWrapper } from '@webb-tools/tokens';
import { LocalEvmChain } from '@webb-tools/test-utils';
import child from 'child_process';
import {
  ChainInfo,
  Contract,
  EnabledContracts,
  EventsWatcher,
  FeaturesConfig,
  LinkedAnchor,
  ProposalSigningBackend,
  WithdrawConfig,
} from './webbRelayer';
import { ConvertToKebabCase } from './tsHacks';

export type GanacheAccounts = {
  balance: string;
  secretKey: string;
};

export type ExportedConfigOptions = {
  signatureVBridge?: VBridge.OpenVBridge;
  proposalSigningBackend?: ProposalSigningBackend;
  features?: FeaturesConfig;
  withdrawConfig?: WithdrawConfig;
  relayerWallet?: Wallet;
  linkedAnchors?: LinkedAnchor[];
  blockConfirmations?: number;
};

// Default Events watcher for the contracts.
export const defaultEventsWatcherValue: EventsWatcher = {
  enabled: true,
  pollingInterval: 1000,
  printProgressInterval: 60_000,
};

type LocalChainOpts = {
  name: string;
  port: number;
  chainId: number;
  populatedAccounts: GanacheAccounts[];
  enableLogging?: boolean;
  enabledContracts: EnabledContracts[];
};

export class LocalChain {
  private localEvmChain: LocalEvmChain;
  public readonly endpoint: string;
  private signatureVBridge: VBridge.OpenVBridge | null = null;
  private constructor(
    private readonly opts: LocalChainOpts,
    localEvmChain: LocalEvmChain
  ) {
    this.localEvmChain = localEvmChain;
    this.endpoint = `http://127.0.0.1:${opts.chainId}`;
  }

  public static async init(opts: LocalChainOpts) {
    const evmChain = await LocalEvmChain.init(
      opts.name,
      opts.chainId,
      opts.populatedAccounts
    );
    const localChain = new LocalChain(opts, evmChain);
    return localChain;
  }

  public get name(): string {
    return this.opts.name;
  }

  public get chainId(): number {
    return Utility.getChainIdType(this.opts.chainId);
  }

  public get underlyingChainId(): number {
    return this.opts.chainId;
  }

  public provider(): ethers.providers.WebSocketProvider {
    return new ethers.providers.WebSocketProvider(this.endpoint, {
      name: this.opts.name,
      chainId: this.underlyingChainId,
    });
  }

  public async stop() {
    await this.localEvmChain.stop();
  }

  public async deployToken(
    name: string,
    symbol: string,
    wallet: ethers.Wallet
  ): Promise<MintableToken> {
    return MintableToken.createToken(name, symbol, wallet);
  }
  public async deployVBridge(
    localToken: MintableToken,
    localWallet: ethers.Wallet,
    initialGovernor: ethers.Wallet
  ): Promise<VBridge.OpenVBridge> {
    const webbTokens1 = new Map<number, GovernedTokenWrapper | undefined>();
    webbTokens1.set(this.chainId, null!);
    const vBridgeInput: VBridge.VBridgeInput = {
      vAnchorInputs: {
        asset: {
          [this.chainId]: [localToken.contract.address],
        },
      },
      chainIDs: [this.chainId],
      webbTokens: webbTokens1,
    };
    const deployerConfig: DeployerConfig = {
      [this.chainId]: localWallet,
    };
    const deployerGovernors: GovernorConfig = {
      [this.chainId]: initialGovernor.address,
    };

    const vBridge = await VBridge.OpenVBridge.deployVariableAnchorBridge(
      vBridgeInput,
      deployerConfig,
      deployerGovernors
    );

    return vBridge;
  }

  public async deploySignatureVBridge(
    otherChain: LocalChain,
    localToken: MintableToken,
    otherToken: MintableToken,
    localWallet: ethers.Wallet,
    otherWallet: ethers.Wallet,
    initialGovernors?: GovernorConfig
  ): Promise<VBridge.OpenVBridge> {
    const webbTokens1: Map<number, GovernedTokenWrapper | undefined> = new Map<
      number,
      GovernedTokenWrapper | undefined
    >();
    webbTokens1.set(this.chainId, null!);
    webbTokens1.set(otherChain.chainId, null!);
    const vBridgeInput: VBridge.VBridgeInput = {
      vAnchorInputs: {
        asset: {
          [this.chainId]: [localToken.contract.address],
          [otherChain.chainId]: [otherToken.contract.address],
        },
      },
      chainIDs: [this.chainId, otherChain.chainId],
      webbTokens: webbTokens1,
    };
    const deployerConfig: DeployerConfig = {
      [this.chainId]: localWallet,
      [otherChain.chainId]: otherWallet,
    };
    const deployerGovernors: GovernorConfig = {
      [this.chainId]: localWallet.address,
      [otherChain.chainId]: otherWallet.address,
    };

    const vBridge = await VBridge.OpenVBridge.deployVariableAnchorBridge(
      vBridgeInput,
      deployerConfig,
      deployerGovernors
    );

    this.signatureVBridge = vBridge;

    if (initialGovernors) {
      const govEntries = Object.entries(initialGovernors);

      for (const entry of govEntries) {
        const chainBridgeSide = this.signatureVBridge.getVBridgeSide(
          Number(entry[0])
        );
        console.log('entry: ', entry);
        console.log(await chainBridgeSide.contract.signer.getAddress());
        const nonce = await chainBridgeSide.contract.proposalNonce();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const tx = await chainBridgeSide.transferOwnership(
              entry[1],
              nonce.toNumber()
            );
            await tx.wait();
            break;
          } catch (e) {
            console.log(e);
          }
        }
      }
    }

    return vBridge;
  }

  private async getVAnchorChainConfig(
    opts: ExportedConfigOptions
  ): Promise<FullChainInfo> {
    const bridge = opts.signatureVBridge ?? this.signatureVBridge;
    if (!bridge) {
      throw new Error('Signature V bridge not deployed yet');
    }
    const localAnchor = bridge.getVAnchor(this.chainId);
    const side = bridge.getVBridgeSide(this.chainId);
    const wallet = opts.relayerWallet ?? side.governor;
    const contracts: Contract[] = [
      // first the local Anchor
      {
        contract: 'OpenVAnchor',
        address: localAnchor.getAddress(),
        deployedAt: 1,
        size: 1, // Ethers
        proposalSigningBackend: opts.proposalSigningBackend,
        withdrawConfig: opts.withdrawConfig,
        eventsWatcher: {
          enabled: true,
          pollingInterval: 1000,
          printProgressInterval: 60_000,
        },
        linkedAnchors: opts.linkedAnchors,
      },
      {
        contract: 'SignatureBridge',
        address: side.contract.address,
        deployedAt: 1,
        eventsWatcher: {
          enabled: true,
          pollingInterval: 1000,
          printProgressInterval: 60_000,
        },
      },
    ];
    const chainInfo: FullChainInfo = {
      name: this.underlyingChainId.toString(),
      enabled: true,
      httpEndpoint: this.endpoint,
      wsEndpoint: this.endpoint.replace('http', 'ws'),
      chainId: this.underlyingChainId,
      beneficiary: (wallet as ethers.Wallet).address,
      privateKey: (wallet as ethers.Wallet).privateKey,
      contracts: contracts,
      blockConfirmations: 1,
    };
    return chainInfo;
  }

  public async exportConfig(
    opts: ExportedConfigOptions
  ): Promise<FullChainInfo> {
    const chainInfo: FullChainInfo = {
      name: this.underlyingChainId.toString(),
      enabled: true,
      httpEndpoint: this.endpoint,
      wsEndpoint: this.endpoint.replace('http', 'ws'),
      chainId: this.underlyingChainId,
      beneficiary: '',
      privateKey: '',
      contracts: [],
      blockConfirmations: 1,
    };
    for (const contract of this.opts.enabledContracts) {
      if (contract.contract == 'OpenVAnchor') {
        return this.getVAnchorChainConfig(opts);
      }
    }
    return chainInfo;
  }

  public async writeConfig(
    path: string,
    opts: ExportedConfigOptions
  ): Promise<void> {
    const config = await this.exportConfig(opts);
    // don't mind my typescript typing here XD
    type ConvertedLinkedAnchor = ConvertToKebabCase<LinkedAnchor>;
    type ConvertedContract = Omit<
      ConvertToKebabCase<Contract>,
      | 'events-watcher'
      | 'proposal-signing-backend'
      | 'withdraw-config'
      | 'linked-anchors'
    > & {
      'events-watcher': ConvertToKebabCase<EventsWatcher>;
      'proposal-signing-backend'?: ConvertToKebabCase<ProposalSigningBackend>;
      'withdraw-config'?: ConvertToKebabCase<WithdrawConfig>;
      'linked-anchors'?: ConvertedLinkedAnchor[];
    };
    type ConvertedConfig = Omit<
      ConvertToKebabCase<typeof config>,
      'contracts'
    > & {
      contracts: ConvertedContract[];
    };
    type FullConfigFile = {
      evm: {
        // chainId as the chain identifier
        [key: number]: ConvertedConfig;
      };
      features?: ConvertToKebabCase<FeaturesConfig>;
    };

    const convertedConfig: ConvertedConfig = {
      name: config.name,
      enabled: config.enabled,
      'block-confirmations': config.blockConfirmations,
      'http-endpoint': config.httpEndpoint,
      'ws-endpoint': config.wsEndpoint,
      'chain-id': config.chainId,
      beneficiary: config.beneficiary,
      'private-key': config.privateKey,
      contracts: config.contracts.map((contract) => ({
        contract: contract.contract,
        address: contract.address,
        'deployed-at': contract.deployedAt,
        'proposal-signing-backend':
          contract.proposalSigningBackend?.type === 'Mocked'
            ? {
                type: 'Mocked',
                'private-key': contract.proposalSigningBackend?.privateKey,
              }
            : contract.proposalSigningBackend?.type === 'DKGNode'
            ? {
                type: 'DKGNode',
                node: contract.proposalSigningBackend?.node,
              }
            : undefined,
        'withdraw-config': contract.withdrawConfig
          ? {
              'withdraw-fee-percentage':
                contract.withdrawConfig?.withdrawFeePercentage,
              'withdraw-gaslimit': contract.withdrawConfig?.withdrawGaslimit,
            }
          : undefined,
        'events-watcher': {
          enabled: contract.eventsWatcher.enabled,
          'polling-interval': contract.eventsWatcher.pollingInterval,
          'print-progress-interval':
            contract.eventsWatcher.printProgressInterval,
        },
        'linked-anchors': contract?.linkedAnchors?.map((anchor: LinkedAnchor) =>
          anchor.type === 'Evm'
            ? {
                'chain-id': anchor.chainId,
                type: 'Evm',
                address: anchor.address,
              }
            : anchor.type === 'Substrate'
            ? {
                type: 'Substrate',
                'chain-id': anchor.chainId,
                'tree-id': anchor.treeId,
                pallet: anchor.pallet,
              }
            : {
                type: 'Raw',
                'resource-id': anchor.resourceId,
              }
        ),
      })),
    };
    const fullConfigFile: FullConfigFile = {
      evm: {
        [this.underlyingChainId]: convertedConfig,
      },
      features: {
        'data-query': opts.features?.dataQuery ?? true,
        'governance-relay': opts.features?.governanceRelay ?? true,
        'private-tx-relay': opts.features?.privateTxRelay ?? true,
      },
    };
    const configString = JSON.stringify(fullConfigFile, null, 2);
    fs.writeFileSync(path, configString);
  }
}

export type FullChainInfo = ChainInfo & {
  httpEndpoint: string;
  wsEndpoint: string;
  privateKey: string;
};
