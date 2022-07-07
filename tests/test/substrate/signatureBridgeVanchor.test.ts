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
// This is Substrate VAnchor Transaction Relayer Tests.
// In this test relayer on vanchor deposit will create and relay proposals to signature bridge pallet for execution

import '@webb-tools/types';
import getPort, { portNumbers } from 'get-port';
import temp from 'temp';
import path from 'path';
import fs from 'fs';
import isCi from 'is-ci';
import child from 'child_process';
import { ethers} from 'ethers';
import { WebbRelayer,Pallet,toFixedHex, convertToHexNumber, toHex, getChainIdType } from '../../lib/webbRelayer.js';
import { LocalProtocolSubstrate } from '../../lib/localProtocolSubstrate.js';
import { SubmittableExtrinsic } from '@polkadot/api/types';
import {
  UsageMode,
  defaultEventsWatcherValue,
} from '../../lib/substrateNodeBase.js';
import { BigNumber } from 'ethers';
import { ApiPromise, Keyring } from '@polkadot/api';
import { u8aToHex, hexToU8a } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';
import { naclEncrypt, randomAsU8a } from '@polkadot/util-crypto';

import {
  Note,
  ProvingManagerSetupInput,
  ArkworksProvingManager,
  Utxo,
} from '@webb-tools/sdk-core';

import {
    encodeResourceIdUpdateProposal,
    ResourceIdUpdateProposal,
} from '../../lib/substrateWebbProposals.js';
import { ChainIdType, makeResourceId } from '../../lib/webbProposals.js';
import pkg from 'secp256k1';
const { ecdsaSign } = pkg;

describe('Substrate Signature Bridge Relaying On Vanchor Deposit <<>> Mocked Backend', function () {
  const tmpDirPath = temp.mkdirSync();
  let aliceNode: LocalProtocolSubstrate;
  let bobNode: LocalProtocolSubstrate;
  let webbRelayer: WebbRelayer;
  
  // Governer key
  const PK1 = u8aToHex(ethers.utils.randomBytes(32));
  let governorWallet = new ethers.Wallet(PK1)
  // slice 0x04 from public key
  let uncompressedKey = governorWallet._signingKey().publicKey.slice(4);
  let typedSourceChainId = getChainIdType(ChainIdType.SUBSTRATE, 1080);

  before(async () => {
    const usageMode: UsageMode = isCi
      ? { mode: 'docker', forcePullImage: false }
      : {
          mode: 'host',
          nodePath: path.resolve(
            '../../protocol-substrate/target/release/webb-standalone-node'
          ),
        };
    const enabledPallets: Pallet[] = [
      {
        pallet: 'VAnchorBn254',
        eventsWatcher: defaultEventsWatcherValue,
      },
      {
        pallet: 'SignatureBridge',
        eventsWatcher: defaultEventsWatcherValue,
      },
    ];

    aliceNode = await LocalProtocolSubstrate.start({
      name: 'substrate-alice',
      authority: 'alice',
      usageMode,
      ports: 'auto',
      enabledPallets,
      enableLogging: false,
    });

    bobNode = await LocalProtocolSubstrate.start({
      name: 'substrate-bob',
      authority: 'bob',
      usageMode,
      ports: 'auto',
      enableLogging: false,
    });

    await aliceNode.writeConfig(`${tmpDirPath}/${aliceNode.name}.json`, {
      suri: '//Charlie',
      proposalSigningBackend: { type: 'Mocked', privateKey: PK1 },
      linkedAnchors: [
        {
          chain: 1080,
          tree: 9,
        },
      ],
    });

    // Wait until we are ready and connected
    const api = await aliceNode.api();
    await api.isReady;

    //force set maintainer
    let setMaintainerCall = api.tx.signatureBridge!.forceSetMaintainer!(
        Array.from(hexToU8a(uncompressedKey))
    );
    await aliceNode.sudoExecuteTransaction(setMaintainerCall);
  
    //whitelist chain
    let whitelistChainCall = api.tx.signatureBridge!.whitelistChain!(typedSourceChainId);
    await aliceNode.sudoExecuteTransaction(whitelistChainCall);

    // now start the relayer
    const relayerPort = await getPort({ port: portNumbers(8000, 8888) });
    webbRelayer = new WebbRelayer({
      port: relayerPort,
      tmp: true,
      configDir: tmpDirPath,
      showLogs: false,
    });
    await webbRelayer.waitUntilReady();
  });

  it('Relayer should create and relay anchor update proposal to signature bridge for execution', async () => {
    const api = await aliceNode.api();
    const account = createAccount('//Dave');
    //create vanchor
    let createVAnchorCall = api.tx.vAnchorBn254!.create!(1, 30, 0);
    await aliceNode.sudoExecuteTransaction(createVAnchorCall);

    const nextTreeId = await api.query.merkleTreeBn254.nextTreeId();
    const treeId = nextTreeId.toNumber() - 1;

    // now we set resource through proposal execution
    let setResourceIdProposalCall = await setResourceIdProposal(api,PK1,treeId);
    const txSigned = await setResourceIdProposalCall.signAsync(account);
    await aliceNode.executeTransaction(txSigned);

    // vanchor deposit
    await vanchorDeposit(treeId,api, aliceNode);

    // now we wait for the proposal to be signed by mocked backend and then send data to signature bridge
    await webbRelayer.waitForEvent({
      kind: 'signing_backend',
      event: {
        backend: 'Mocked',
      },
    });

    // now we wait for the proposals to verified and executed by signature bridge

    await webbRelayer.waitForEvent({
      kind: 'signature_bridge',
      event: {
        call: 'executed_proposal_with_signature',
      },
    });

    
  });

  after(async () => {
    await aliceNode?.stop();
    await bobNode?.stop();
    await webbRelayer?.stop();
  });
});

// Helper methods, we can move them somewhere if we end up using them again.

async function setResourceIdProposal(api:ApiPromise, PK1: string, treeId: number): Promise<SubmittableExtrinsic<'promise'>>{
    // set resource ID
  let chainID = 1080;
  let resourceId = makeResourceId(toHex(treeId, 20),ChainIdType.SUBSTRATE,chainID);
  let functionSignature = toFixedHex(0,4);
  let nonce = BigNumber.from(1);
  let newResourceId = resourceId;
  let targetSystem = '0x0109000000';
  let palletIndex = convertToHexNumber(46);
  let callIndex = convertToHexNumber(2);
    const resourceIdUpdateProposalPayload: ResourceIdUpdateProposal = {
      header: {
        resourceId,
        functionSignature: functionSignature,
        nonce: nonce.toNumber(),
        chainIdType: ChainIdType.SUBSTRATE,
        chainId: 1080,
      },
      newResourceId,
      targetSystem,
      palletIndex,
      callIndex,
    };
    let proposalBytes = encodeResourceIdUpdateProposal(
      resourceIdUpdateProposalPayload
    );
    let hash = ethers.utils.keccak256(proposalBytes);
    let msg = ethers.utils.arrayify(hash);
    // sign the message
    const sigObj = ecdsaSign(msg, hexToU8a(PK1));
    let signature = new Uint8Array([...sigObj.signature, sigObj.recid])
    // execute proposal call to handler 
    let executeSetProposalCall = api.tx.vAnchorHandlerBn254!.executeSetResourceProposal!(resourceId,targetSystem);
    let setResourceCall = api.tx.signatureBridge!.setResourceWithSignature!(
     getChainIdType(ChainIdType.SUBSTRATE, chainID),
     executeSetProposalCall,
     u8aToHex(proposalBytes),
     u8aToHex(signature)
    );
    return setResourceCall
  }

async function vanchorDeposit(treeId: number, api: ApiPromise, aliceNode: LocalProtocolSubstrate) {
    const account = createAccount('//Dave');
    const chainId = '2199023256632';
    const outputChainId = BigInt(chainId);
    const secret = randomAsU8a();
    const gitRoot = child
      .execSync('git rev-parse --show-toplevel')
      .toString()
      .trim();

    const pkPath = path.join(
      // tests path
      gitRoot,
      'tests',
      'protocol-substrate-fixtures',
      'vanchor',
      'bn254',
      'x5',
      '2-2-2',
      'proving_key_uncompressed.bin'
    );
    const pk_hex = fs.readFileSync(pkPath).toString('hex');
    const pk = hexToU8a(pk_hex);

    // Creating two empty vanchor notes
    const note1 = await generateVAnchorNote(
      0,
      Number(outputChainId.toString()),
      Number(outputChainId.toString()),
      0
    );
    const note2 = await note1.getDefaultUtxoNote();
    const publicAmount = currencyToUnitI128(10);
    const notes = [note1, note2];
    // Output UTXOs configs
    const output1 = await Utxo.generateUtxo({
      curve: 'Bn254',
      backend: 'Arkworks',
      amount: publicAmount.toString(),
      chainId,
    });
    const output2 = await Utxo.generateUtxo({
      curve: 'Bn254',
      backend: 'Arkworks',
      amount: '0',
      chainId,
    });

    // Configure a new proving manager with direct call
    const provingManager = new ArkworksProvingManager(null);
    const leavesMap: any = {};

    const address = account.address;
    const extAmount = currencyToUnitI128(10);
    const fee = 0;
    // Empty leaves
    leavesMap[outputChainId.toString()] = [];
    const tree = await api.query.merkleTreeBn254.trees(treeId);
    const root = tree.unwrap().root.toHex();
    const rootsSet = [hexToU8a(root), hexToU8a(root)];
    const decodedAddress = decodeAddress(address);
    const { encrypted: comEnc1 } = naclEncrypt(output1.commitment, secret);
    const { encrypted: comEnc2 } = naclEncrypt(output2.commitment, secret);

    const setup: ProvingManagerSetupInput<'vanchor'> = {
      chainId: outputChainId.toString(),
      indices: [0, 0],
      inputNotes: notes,
      leavesMap: leavesMap,
      output: [output1, output2],
      encryptedCommitments: [comEnc1, comEnc2],
      provingKey: pk,
      publicAmount: String(publicAmount),
      roots: rootsSet,
      relayer: decodedAddress,
      recipient: decodedAddress,
      extAmount: extAmount.toString(),
      fee: fee.toString(),
    };

    const data = await provingManager.prove('vanchor', setup);
    const extData = {
      relayer: address,
      recipient: address,
      fee,
      extAmount: extAmount,
      encryptedOutput1: u8aToHex(comEnc1),
      encryptedOutput2: u8aToHex(comEnc2),
    };

    let vanchorProofData = {
      proof: `0x${data.proof}`,
      publicAmount: data.publicAmount,
      roots: rootsSet,
      inputNullifiers: data.inputUtxos.map((input) => `0x${input.nullifier}`),
      outputCommitments: data.outputNotes.map((note) =>
        u8aToHex(note.note.getLeafCommitment())
      ),
      extDataHash: data.extDataHash,
    };
    const leafsCount = await api.derive.merkleTreeBn254.getLeafCountForTree(
      Number(treeId)
    );
    const indexBeforeInsetion = Math.max(leafsCount - 1, 0);

    // now we call the vanchor transact
    let transactCall = api.tx.vAnchorBn254!.transact!(
      treeId,
      vanchorProofData,
      extData
    );
    const txSigned = await transactCall.signAsync(account);
    await aliceNode.executeTransaction(txSigned);
}

function currencyToUnitI128(currencyAmount: number) {
  let bn = BigNumber.from(currencyAmount);
  return bn.mul(1_000_000_000_000);
}

async function generateVAnchorNote(
  amount: number,
  chainId: number,
  outputChainId: number,
  index?: number
) {
  const note = await Note.generateNote({
    amount: String(amount),
    backend: 'Arkworks',
    curve: 'Bn254',
    denomination: String(18),
    exponentiation: String(5),
    hashFunction: 'Poseidon',
    index,
    protocol: 'vanchor',
    sourceChain: String(chainId),
    sourceIdentifyingData: '1',
    targetChain: String(outputChainId),
    targetIdentifyingData: '1',
    tokenSymbol: 'WEBB',
    version: 'v2',
    width: String(5),
  });

  return note;
}

function createAccount(accountId: string): any {
  const keyring = new Keyring({ type: 'sr25519' });
  const account = keyring.addFromUri(accountId);

  return account;
}
