export type YespowerAlgorithm = {
  id: string;
  displayName: string;
  poolAlgorithm: string;
  N: number;
  r: number;
  personalization: string | null;
};

export const YESPOWER_ALGORITHMS = {
  yespower: {
    id: "yespower",
    displayName: "YesPower",
    poolAlgorithm: "yespower",
    N: 2048,
    r: 32,
    personalization: null
  },

  yespowertide: {
    id: "yespowertide",
    displayName: "YesPower TIDE",
    poolAlgorithm: "yespowerTIDE",
    N: 2048,
    r: 8,
    personalization: null
  },

  yespowerr16: {
    id: "yespowerr16",
    displayName: "YesPower R16",
    poolAlgorithm: "yespowerR16",
    N: 4096,
    r: 16,
    personalization: null
  },

  yespowerurx: {
    id: "yespowerurx",
    displayName: "YesPower URX",
    poolAlgorithm: "yespowerURX",
    N: 2048,
    r: 32,
    personalization: "UraniumX"
  },

  yespoweradvc: {
    id: "yespoweradvc",
    displayName: "YesPower ADVC",
    poolAlgorithm: "yespowerADVC",
    N: 2048,
    r: 32,
    personalization: "Let the quest begin"
  },

  yespowerltncg: {
    id: "yespowerltncg",
    displayName: "YesPower LTNCG",
    poolAlgorithm: "yespowerLTNCG",
    N: 2048,
    r: 32,
    personalization: "LTNCGYES"
  },

  yespowersugar: {
    id: "yespowersugar",
    displayName: "YesPower SUGAR",
    poolAlgorithm: "yespowerSUGAR",
    N: 2048,
    r: 32,
    personalization:
      "Satoshi Nakamoto 31/Oct/2008 Proof-of-work is essentially one-CPU-one-vote"
  }
} as const satisfies Record<string, YespowerAlgorithm>;

export type AlgorithmId = keyof typeof YESPOWER_ALGORITHMS;

export const ALGORITHM_IDS =
  Object.keys(YESPOWER_ALGORITHMS) as AlgorithmId[];

export function isAlgorithmId(value: string): value is AlgorithmId {
  return Object.prototype.hasOwnProperty.call(
    YESPOWER_ALGORITHMS,
    value
  );
}

export function getAlgorithm(
  id: AlgorithmId
): YespowerAlgorithm {
  return YESPOWER_ALGORITHMS[id];
}
