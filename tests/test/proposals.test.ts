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

// Testing different kind of proposals between DKG <=> Relayer <=> Signature Bridge.

import '@webb-tools/protocol-substrate-types';
import Chai, { expect } from 'chai';
import ChaiAsPromised from 'chai-as-promised';
import { Tokens, VBridge } from '@webb-tools/protocol-solidity';
import { u8aToHex } from '@polkadot/util';
import { ethers } from 'ethers';
import temp from 'temp';
import retry from 'async-retry';
import { LocalChain } from '../lib/localTestnet.js';
import { Pallet, WebbRelayer, EnabledContracts } from '../lib/webbRelayer.js';
import getPort, { portNumbers } from 'get-port';
import { LocalDkg } from '../lib/localDkg.js';
import isCi from 'is-ci';
import path from 'path';
import { ethAddressFromUncompressedPublicKey } from '../lib/ethHelperFunctions.js';
import { sleep } from '../lib/sleep.js';
import {
  ProposalHeader,
  ResourceId,
  TokenAddProposal,
  TokenRemoveProposal,
  WrappingFeeUpdateProposal,
} from '@webb-tools/sdk-core';
import { hexToU8a } from '@polkadot/util';
import { ChainType } from '@webb-tools/sdk-core';
import { UsageMode } from '@webb-tools/test-utils';
import { defaultEventsWatcherValue } from '../lib/utils.js';

// to support chai-as-promised
Chai.use(ChaiAsPromised);

describe.skip('Proposals (DKG <=> Relayer <=> SigBridge)', function () {
  // 8 minutes
  this.timeout(8 * 60 * 1000);
  const tmpDirPath = temp.mkdirSync();
  let localChain1: LocalChain;
  let localChain2: LocalChain;
  let signatureBridge: VBridge.VBridge;
  let wallet1: ethers.Wallet;
  let wallet2: ethers.Wallet;

  // dkg nodes
  let aliceNode: LocalDkg;
  let bobNode: LocalDkg;
  let charlieNode: LocalDkg;

  let webbRelayer: WebbRelayer;

  before(async function () {
    // Only run these tests in CI
    if (!isCi) this.skip();
    const PK1 = u8aToHex(ethers.utils.randomBytes(32));
    const PK2 = u8aToHex(ethers.utils.randomBytes(32));
    const usageMode: UsageMode = isCi
      ? { mode: 'host', nodePath: 'dkg-standalone-node' }
      : {
          mode: 'host',
          nodePath: path.resolve(
            '../../dkg-substrate/target/release/dkg-standalone-node'
          ),
        };
    const enabledPallets: Pallet[] = [
      {
        pallet: 'DKGProposalHandler',
        eventsWatcher: defaultEventsWatcherValue,
      },
    ];
    aliceNode = await LocalDkg.start({
      name: 'substrate-alice',
      authority: 'alice',
      usageMode,
      ports: 'auto',
    });

    bobNode = await LocalDkg.start({
      name: 'substrate-bob',
      authority: 'bob',
      usageMode,
      ports: 'auto',
    });

    charlieNode = await LocalDkg.start({
      name: 'substrate-charlie',
      authority: 'charlie',
      usageMode,
      ports: 'auto',
      enableLogging: false,
    });

    // get chainId
    const chainId = await charlieNode.getChainId();
    await charlieNode.writeConfig(`${tmpDirPath}/${charlieNode.name}.json`, {
      suri: '//Charlie',
      chainId: chainId,
      enabledPallets,
    });

    // we need to wait until the public key is on chain.
    await charlieNode.waitForEvent({
      section: 'dkg',
      method: 'PublicKeySubmitted',
    });

    // next we need to start local evm node.
    const localChain1Port = await getPort({
      port: portNumbers(3333, 4444),
    });

    const enabledContracts: EnabledContracts[] = [
      {
        contract: 'Anchor',
      },
    ];
    localChain1 = await LocalChain.init({
      port: localChain1Port,
      chainId: localChain1Port,
      name: 'Hermes',
      populatedAccounts: [
        {
          secretKey: PK1,
          balance: ethers.utils.parseEther('1000').toHexString(),
        },
      ],
      enabledContracts: enabledContracts,
    });

    const localChain2Port = await getPort({
      port: portNumbers(3333, 4444),
    });

    localChain2 = await LocalChain.init({
      port: localChain2Port,
      chainId: localChain2Port,
      name: 'Athena',
      populatedAccounts: [
        {
          secretKey: PK2,
          balance: ethers.utils.parseEther('1000').toHexString(),
        },
      ],
      enabledContracts: enabledContracts,
    });

    wallet1 = new ethers.Wallet(PK1, localChain1.provider());
    wallet2 = new ethers.Wallet(PK2, localChain2.provider());
    // Deploy the token.
    const localToken1 = await localChain1.deployToken(
      'Webb Token',
      'WEBB',
      wallet1
    );
    const localToken2 = await localChain2.deployToken(
      'Webb Token',
      'WEBB',
      wallet2
    );

    signatureBridge = await localChain1.deploySignatureVBridge(
      localChain2,
      localToken1,
      localToken2,
      wallet1,
      wallet2
    );
    // save the chain configs.
    await localChain1.writeConfig(`${tmpDirPath}/${localChain1.name}.json`, {
      signatureVBridge: signatureBridge,
      proposalSigningBackend: { type: 'DKGNode', node: charlieNode.name },
    });
    await localChain2.writeConfig(`${tmpDirPath}/${localChain2.name}.json`, {
      signatureVBridge: signatureBridge,
      proposalSigningBackend: { type: 'DKGNode', node: charlieNode.name },
    });
    // fetch the dkg public key.
    const dkgPublicKey = await charlieNode.fetchDkgPublicKey();
    expect(dkgPublicKey).to.not.be.null;
    const governorAddress = ethAddressFromUncompressedPublicKey(dkgPublicKey!);
    // verify the governor address is a valid ethereum address.
    expect(ethers.utils.isAddress(governorAddress)).to.be.true;
    // transfer ownership to the DKG.
    const sides = signatureBridge.vBridgeSides.values();
    for (const signatureSide of sides) {
      // now we transferOwnership, forcefully.
      const tx = await signatureSide.transferOwnership(governorAddress, 1);
      await retry(
        async () => {
          await tx.wait();
        },
        {
          retries: 5,
          minTimeout: 2000,
          onRetry: (_error) => {
            console.error('`transferOwnership` call failed, retrying...');
          },
        }
      );
      // check that the new governor is the same as the one we just set.
      const currentGovernor = await signatureSide.contract.governor();
      expect(currentGovernor).to.eq(governorAddress);
    }
    // get the anhor on localchain1
    const anchor = signatureBridge.getVAnchor(localChain1.chainId);
    await anchor.setSigner(wallet1);
    // approve token spending
    const tokenAddress = signatureBridge.getWebbTokenAddress(
      localChain1.chainId
    )!;
    const token = await Tokens.MintableToken.tokenFromAddress(
      tokenAddress,
      wallet1
    );
    let tx = await token.approveSpending(anchor.contract.address);
    await tx.wait();
    await token.mintTokens(wallet1.address, ethers.utils.parseEther('1000'));

    // do the same but on localchain2
    const anchor2 = signatureBridge.getVAnchor(localChain2.chainId);
    await anchor2.setSigner(wallet2);
    const tokenAddress2 = signatureBridge.getWebbTokenAddress(
      localChain2.chainId
    )!;
    const token2 = await Tokens.MintableToken.tokenFromAddress(
      tokenAddress2,
      wallet2
    );

    tx = await token2.approveSpending(anchor2.contract.address);
    await tx.wait();
    await token2.mintTokens(wallet2.address, ethers.utils.parseEther('1000'));

    const api = await charlieNode.api();
    const resourceId1 = await anchor.createResourceId();
    const resourceId2 = await anchor2.createResourceId();
    const governedTokenAddress = anchor.token!;
    const governedToken = Tokens.GovernedTokenWrapper.connect(
      governedTokenAddress,
      wallet1
    );
    const resourceId3 = await governedToken.createResourceId();
    const setResourceCall = (resourceId: string) =>
      api.tx.dkgProposals.setResource(resourceId, '0x00');
    // register the resource on DKG node.
    const rids = [resourceId1, resourceId2, resourceId3];
    for (const rid of rids) {
      await charlieNode.sudoExecuteTransaction(setResourceCall(rid));
    }
    // now start the relayer
    const relayerPort = await getPort({ port: portNumbers(9955, 9999) });
    webbRelayer = new WebbRelayer({
      tmp: true,
      commonConfig: {
        port: relayerPort,
      },
      configDir: tmpDirPath,
      showLogs: false,
      verbosity: 3,
    });
    await webbRelayer.waitUntilReady();
  });

  it('should handle TokenAddProposal', async () => {
    // get the anhor on localchain1
    const anchor = signatureBridge.getVAnchor(localChain1.chainId);
    //Create an ERC20 Token
    const testToken = await Tokens.MintableToken.createToken(
      'testToken',
      'TEST',
      wallet1
    );
    const governedTokenAddress = anchor.token!;
    const governedToken = Tokens.GovernedTokenWrapper.connect(
      governedTokenAddress,
      wallet1
    );
    const resourceId = ResourceId.newFromContractAddress(
      governedTokenAddress,
      ChainType.EVM,
      await governedToken.signer.getChainId()
    );
    const functionSignature = hexToU8a(
      governedToken.contract.interface.getSighash(
        governedToken.contract.interface.functions['add(address,uint256)']
      )
    );
    const nonce = await governedToken.contract.proposalNonce();
    const proposalHeader = new ProposalHeader(
      resourceId,
      functionSignature,
      nonce.toNumber()
    );
    const tokenAddProposal = new TokenAddProposal(
      proposalHeader,
      testToken.contract.address
    );
    await forceSubmitUnsignedProposal(charlieNode, {
      kind: 'TokenAdd',
      data: u8aToHex(tokenAddProposal.toU8a()),
    });
    // now we wait for the proposal to be signed.
    charlieNode.waitForEvent({
      section: 'dkgProposalHandler',
      method: 'ProposalSigned',
    });
    // now we wait for the proposal to be executed by the relayer then by the Signature Bridge.
    await webbRelayer.waitForEvent({
      kind: 'signature_bridge',
      event: { chain_id: localChain1.underlyingChainId.toString() },
    });
    // now we wait for the tx queue on that chain to execute the transaction.
    await webbRelayer.waitForEvent({
      kind: 'tx_queue',
      event: {
        ty: 'EVM',
        chain_id: localChain1.underlyingChainId.toString(),
        finalized: true,
      },
    });
    await sleep(1000);
    // now we check that the token was added.
    const tokens = await governedToken.contract.getTokens();
    expect(tokens.includes(testToken.contract.address)).to.eq(true);
  });

  it('should handle TokenRemoveProposal', async () => {
    // get the anhor on localchain1
    const anchor = signatureBridge.getVAnchor(localChain1.chainId);
    const governedTokenAddress = anchor.token!;
    const governedToken = Tokens.GovernedTokenWrapper.connect(
      governedTokenAddress,
      wallet1
    );
    const currentTokens = await governedToken.contract.getTokens();
    const tokenToRemove = currentTokens[0];
    expect(tokenToRemove).to.not.be.undefined;
    // but first, remove all realyer old events (as in reset the event listener)
    webbRelayer.clearLogs();
    const resourceId = ResourceId.newFromContractAddress(
      governedTokenAddress,
      ChainType.EVM,
      await governedToken.signer.getChainId()
    );
    const functionSignature = hexToU8a(
      governedToken.contract.interface.getSighash(
        governedToken.contract.interface.functions['remove(address,uint256)']
      )
    );
    const nonce = await governedToken.contract.proposalNonce();
    const proposalHeader = new ProposalHeader(
      resourceId,
      functionSignature,
      nonce.toNumber()
    );
    const tokenAddProposal = new TokenRemoveProposal(
      proposalHeader,
      tokenToRemove!
    );
    await forceSubmitUnsignedProposal(charlieNode, {
      kind: 'TokenRemove',
      data: u8aToHex(tokenAddProposal.toU8a()),
    });
    // now we wait for the proposal to be signed.
    charlieNode.waitForEvent({
      section: 'dkgProposalHandler',
      method: 'ProposalSigned',
    });
    // now we wait for the proposal to be executed by the relayer then by the Signature Bridge.
    await webbRelayer.waitForEvent({
      kind: 'signature_bridge',
      event: { chain_id: localChain1.underlyingChainId.toString() },
    });
    // now we wait for the tx queue on that chain to execute the transaction.
    await webbRelayer.waitForEvent({
      kind: 'tx_queue',
      event: {
        ty: 'EVM',
        chain_id: localChain1.underlyingChainId.toString(),
        finalized: true,
      },
    });
    await sleep(1000);
    // now we check that the token was removed.
    const tokens = await governedToken.contract.getTokens();
    expect(tokens.includes(tokenToRemove!)).to.eq(false);
  });

  it('should handle WrappingFeeUpdateProposal', async () => {
    // get the anhor on localchain1
    const anchor = signatureBridge.getVAnchor(localChain1.chainId);
    const governedTokenAddress = anchor.token!;
    const governedToken = Tokens.GovernedTokenWrapper.connect(
      governedTokenAddress,
      wallet1
    );
    const resourceId = ResourceId.newFromContractAddress(
      governedTokenAddress,
      ChainType.EVM,
      localChain1.underlyingChainId
    );
    const nonce = await governedToken.contract.proposalNonce();
    const functionSignature = hexToU8a(
      governedToken.contract.interface.getSighash(
        governedToken.contract.interface.functions['setFee(uint8,uint256)']
      )
    );
    const proposalHeader = new ProposalHeader(
      resourceId,
      functionSignature,
      nonce.toNumber()
    );
    webbRelayer.clearLogs();
    const newFee = ethers.utils.hexValue(50);
    const wrappingFeeProposalPayload = new WrappingFeeUpdateProposal(
      proposalHeader,
      newFee
    );
    await forceSubmitUnsignedProposal(charlieNode, {
      kind: 'WrappingFeeUpdate',
      data: u8aToHex(wrappingFeeProposalPayload.toU8a()),
    });
    // now we wait for the proposal to be signed.
    charlieNode.waitForEvent({
      section: 'dkgProposalHandler',
      method: 'ProposalSigned',
    });
    // now we wait for the proposal to be executed by the relayer then by the Signature Bridge.
    await webbRelayer.waitForEvent({
      kind: 'signature_bridge',
      event: { chain_id: localChain1.underlyingChainId.toString() },
    });
    // now we wait for the tx queue on that chain to execute the transaction.
    await webbRelayer.waitForEvent({
      kind: 'tx_queue',
      event: {
        ty: 'EVM',
        chain_id: localChain1.underlyingChainId.toString(),
        finalized: true,
      },
    });
    await sleep(1000);
    const fee = await governedToken.contract.getFee();
    expect(newFee).to.eq(ethers.utils.hexValue(fee));
  });

  after(async () => {
    await aliceNode?.stop();
    await bobNode?.stop();
    await charlieNode?.stop();
    await localChain1?.stop();
    await localChain2?.stop();
    await webbRelayer?.stop();
  });
});

type WebbProposalKind = 'TokenAdd' | 'TokenRemove' | 'WrappingFeeUpdate';

async function forceSubmitUnsignedProposal(
  node: LocalDkg,
  opts: {
    kind: WebbProposalKind;
    data: `0x${string}`;
  }
) {
  const api = await node.api();
  const kind = api.createType(
    'DkgRuntimePrimitivesProposalProposalKind',
    opts.kind
  );
  const proposal = api
    .createType('DkgRuntimePrimitivesProposal', {
      Unsigned: {
        kind,
        data: opts.data,
      },
    })
    .toU8a();
  const call = api.tx.dkgProposalHandler.forceSubmitUnsignedProposal(proposal);
  const txHash = await node.sudoExecuteTransaction(call);
  return txHash;
}
