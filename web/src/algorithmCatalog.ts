export type BrowserAlgorithm = {
  id: string;
  displayName: string;
  N: number;
  r: number;
  personalization: string | null;
};

export const ALGORITHM_BENCHMARKS: BrowserAlgorithm[] = [
  {
    id: "yespower",
    displayName: "YesPower",
    N: 2048,
    r: 32,
    personalization: null
  },
  {
    id: "yespowertide",
    displayName: "YesPower TIDE",
    N: 2048,
    r: 8,
    personalization: null
  },
  {
    id: "yespowerr16",
    displayName: "YesPower R16",
    N: 4096,
    r: 16,
    personalization: null
  },
  {
    id: "yespowerurx",
    displayName: "YesPower URX",
    N: 2048,
    r: 32,
    personalization: "UraniumX"
  },
  {
    id: "yespoweradvc",
    displayName: "YesPower ADVC",
    N: 2048,
    r: 32,
    personalization: "Let the quest begin"
  },
  {
    id: "yespowerltncg",
    displayName: "YesPower LTNCG",
    N: 2048,
    r: 32,
    personalization: "LTNCGYES"
  },
  {
    id: "yespowersugar",
    displayName: "YesPower SUGAR",
    N: 2048,
    r: 32,
    personalization:
      "Satoshi Nakamoto 31/Oct/2008 Proof-of-work is essentially one-CPU-one-vote"
  }
];
