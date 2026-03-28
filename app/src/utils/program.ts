import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import idl from "../../idl/incognitoballots.json";

export const PROGRAM_ID = new PublicKey("78RjobteBhdGBMsbjX1eqTvjWAFnb5PDbUbxEC9mvfec");
export const RPC_URL = "https://api.devnet.solana.com";
export const CONNECTION = new Connection(RPC_URL, "confirmed");
export const ARCIUM_CLUSTER_OFFSET = 456;

export function getProgram(provider: AnchorProvider): Program {
  return new Program(idl as Idl, provider);
}

export function deriveProposalPDA(authority: PublicKey, title: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), authority.toBuffer(), Buffer.from(title)],
    PROGRAM_ID
  );
}

export function deriveVoteRecordPDA(proposal: PublicKey, voter: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote_record"), proposal.toBuffer(), voter.toBuffer()],
    PROGRAM_ID
  );
}

export function getSignPDA(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("ArciumSignerAccount")], PROGRAM_ID)[0];
}
