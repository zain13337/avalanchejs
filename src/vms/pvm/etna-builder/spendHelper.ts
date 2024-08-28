import type { TransferableOutput } from '../../../serializable';
import { TransferableInput } from '../../../serializable';
import type { Utxo } from '../../../serializable/avax/utxo';
import { bigIntMin } from '../../../utils/bigintMath';
import { compareTransferableOutputs } from '../../../utils/sort';
import type { Dimensions } from '../../common/fees/dimensions';
import { addDimensions, dimensionsToGas } from '../../common/fees/dimensions';
import { getInputComplexity, getOutputComplexity } from '../txs/fee';

interface SpendHelperProps {
  changeOutputs: readonly TransferableOutput[];
  complexity: Dimensions;
  gasPrice: bigint;
  inputs: readonly TransferableInput[];
  stakeOutputs: readonly TransferableOutput[];
  toBurn: Map<string, bigint>;
  toStake: Map<string, bigint>;
  weights: Dimensions;
}

/**
 * The SpendHelper class assists in managing and processing the spending of assets,
 * including handling complexities, gas prices, and various outputs and inputs.
 *
 * @class
 */
export class SpendHelper {
  private readonly gasPrice: bigint;
  private readonly toBurn: Map<string, bigint>;
  private readonly toStake: Map<string, bigint>;
  private readonly weights: Dimensions;

  private complexity: Dimensions;
  private changeOutputs: readonly TransferableOutput[];
  private inputs: readonly TransferableInput[];
  private stakeOutputs: readonly TransferableOutput[];

  private inputUTXOs: readonly Utxo[] = [];

  constructor({
    changeOutputs,
    complexity,
    gasPrice,
    inputs,
    stakeOutputs,
    toBurn,
    toStake,
    weights,
  }: SpendHelperProps) {
    this.gasPrice = gasPrice;
    this.toBurn = toBurn;
    this.toStake = toStake;
    this.weights = weights;

    this.complexity = complexity;
    this.changeOutputs = changeOutputs;
    this.inputs = inputs;
    this.stakeOutputs = stakeOutputs;
  }

  /**
   * Adds an input UTXO and its corresponding transferable input to the SpendHelper.
   *
   * @param {Utxo} utxo - The UTXO to be added.
   * @param {TransferableInput} transferableInput - The transferable input corresponding to the UTXO.
   * @returns {SpendHelper} The current instance of SpendHelper for chaining.
   */
  addInput(utxo: Utxo, transferableInput: TransferableInput): SpendHelper {
    const newInputComplexity = getInputComplexity([transferableInput]);

    this.inputs = [...this.inputs, transferableInput];
    this.complexity = addDimensions(this.complexity, newInputComplexity);

    this.inputUTXOs = [...this.inputUTXOs, utxo];

    return this;
  }

  /**
   * Adds a change output to the SpendHelper.
   * Change outputs are outputs that are sent back to the sender.
   *
   * @param {TransferableOutput} transferableOutput - The change output to be added.
   * @returns {Dimensions} The complexity of the change output.
   */
  addChangeOutput(transferableOutput: TransferableOutput): Dimensions {
    this.changeOutputs = [...this.changeOutputs, transferableOutput];

    return getOutputComplexity([transferableOutput]);
  }

  /**
   * Adds a staked output to the SpendHelper.
   * Staked outputs are outputs that are staked by the sender.
   *
   * @param {TransferableOutput} transferableOutput - The staked output to be added.
   * @returns {Dimensions} The complexity of the staked output.
   */
  addStakedOutput(transferableOutput: TransferableOutput): Dimensions {
    this.stakeOutputs = [...this.stakeOutputs, transferableOutput];

    return getOutputComplexity([transferableOutput]);
  }

  /**
   * Adds a transferable output to the SpendHelper.
   *
   * @param {TransferableOutput} transferableOutput - The transferable output to be added.
   * @returns {SpendHelper} The current instance of SpendHelper for chaining.
   */
  addOutputComplexity(transferableOutput: TransferableOutput): SpendHelper {
    const newOutputComplexity = getOutputComplexity([transferableOutput]);

    this.complexity = addDimensions(this.complexity, newOutputComplexity);

    return this;
  }

  /**
   * Determines if a locked asset should be consumed based on its asset ID.
   *
   * @param {string} assetId - The ID of the asset to check.
   * @returns {boolean} - Returns true if the asset should be consumed, false otherwise.
   */
  shouldConsumeLockedAsset(assetId: string): boolean {
    return this.toStake.has(assetId) && this.toStake.get(assetId) !== 0n;
  }

  /**
   * Determines if an asset should be consumed based on its asset ID.
   *
   * @param {string} assetId - The ID of the asset to check.
   * @returns {boolean} - Returns true if the asset should be consumed, false otherwise.
   */
  shouldConsumeAsset(assetId: string): boolean {
    return (
      (this.toBurn.has(assetId) && this.toBurn.get(assetId) !== 0n) ||
      this.shouldConsumeLockedAsset(assetId)
    );
  }

  /**
   * Consumes a locked asset based on its asset ID and amount.
   *
   * @param {string} assetId - The ID of the asset to consume.
   * @param {bigint} amount - The amount of the asset to consume.
   * @returns {bigint} The remaining amount of the asset after consumption.
   */
  consumeLockedAsset(assetId: string, amount: bigint): bigint {
    const assetToStake = this.toStake.get(assetId) ?? 0n;

    // Stake any value that should be staked
    const toStake = bigIntMin(assetToStake, amount);

    this.toStake.set(assetId, assetToStake - toStake);

    return amount - toStake;
  }

  /**
   * Consumes an asset based on its asset ID and amount.
   *
   * @param {string} assetId - The ID of the asset to consume.
   * @param {bigint} amount - The amount of the asset to consume.
   * @returns {bigint} The remaining amount of the asset after consumption.
   */
  consumeAsset(assetId: string, amount: bigint): bigint {
    const assetToBurn = this.toBurn.get(assetId) ?? 0n;

    // Burn any value that should be burned
    const toBurn = bigIntMin(assetToBurn, amount);

    this.toBurn.set(assetId, assetToBurn - toBurn);

    return this.consumeLockedAsset(assetId, amount - toBurn);
  }

  /**
   * Calculates the fee for the SpendHelper based on its complexity and gas price.
   *
   * @returns {bigint} The fee for the SpendHelper.
   */
  calculateFee(): bigint {
    const gas = dimensionsToGas(this.complexity, this.weights);

    return gas * this.gasPrice;
  }

  /**
   * Verifies that all assets have been consumed.
   *
   * @returns {Error | null} An error if any assets have not been consumed, null otherwise.
   */
  verifyAssetsConsumed(): Error | null {
    for (const [assetId, amount] of this.toStake) {
      if (amount === 0n) {
        continue;
      }

      return new Error(
        `Insufficient funds! Provided UTXOs need ${amount} more units of asset ${assetId} to stake`,
      );
    }

    for (const [assetId, amount] of this.toBurn) {
      if (amount === 0n) {
        continue;
      }

      return new Error(
        `Insufficient funds! Provided UTXOs need ${amount} more units of asset ${assetId}`,
      );
    }

    return null;
  }

  /**
   * Gets the inputs, outputs, and UTXOs for the SpendHelper.
   *
   * @returns {object} The inputs, outputs, and UTXOs for the SpendHelper
   */
  getInputsOutputs(): {
    changeOutputs: readonly TransferableOutput[];
    inputs: readonly TransferableInput[];
    inputUTXOs: readonly Utxo[];
    stakeOutputs: readonly TransferableOutput[];
  } {
    const sortedInputs = [...this.inputs].sort(TransferableInput.compare);
    const sortedChangeOutputs = [...this.changeOutputs].sort(
      compareTransferableOutputs,
    );
    const sortedStakeOutputs = [...this.stakeOutputs].sort(
      compareTransferableOutputs,
    );

    return {
      changeOutputs: sortedChangeOutputs,
      inputs: sortedInputs,
      inputUTXOs: this.inputUTXOs,
      stakeOutputs: sortedStakeOutputs,
    };
  }
}
