use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

declare_id!("78RjobteBhdGBMsbjX1eqTvjWAFnb5PDbUbxEC9mvfec");

const COMP_DEF_OFFSET_CAST_VOTE: u32 = comp_def_offset("cast_vote");
const COMP_DEF_OFFSET_REVEAL_TALLY: u32 = comp_def_offset("reveal_tally");
const COMP_DEF_OFFSET_INIT_TALLY: u32 = comp_def_offset("init_tally");
const COMP_DEF_OFFSET_FETCH_TALLY: u32 = comp_def_offset("fetch_tally");

#[arcium_program]
pub mod incognitoballots {
    use super::*;

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        title: String,
        option_0: String,
        option_1: String,
        option_2: String,
        option_3: String,
        option_4: String,
        duration_secs: i64,
        required_token_mint: Pubkey,
        min_token_amount: u64,
    ) -> Result<()> {
        require!(duration_secs >= 600, ErrorCode::DurationTooShort);
        require!(title.len() <= 100, ErrorCode::TitleTooLong);

        let proposal = &mut ctx.accounts.proposal;
        proposal.authority = ctx.accounts.authority.key();
        proposal.title = title;
        proposal.option_0 = option_0;
        proposal.option_1 = option_1;
        proposal.option_2 = option_2;
        proposal.option_3 = option_3;
        proposal.option_4 = option_4;
        proposal.start_time = Clock::get()?.unix_timestamp;
        proposal.end_time = Clock::get()?.unix_timestamp + duration_secs;
        proposal.required_token_mint = required_token_mint;
        proposal.min_token_amount = min_token_amount;
        proposal.is_finalized = false;
        proposal.tally_nonce = [0u8; 16];
        proposal.encrypted_tally = [[0u8; 32]; 5];
        proposal.bump = ctx.bumps.proposal;

        emit!(ProposalCreated {
            proposal: proposal.key(),
            title: proposal.title.clone(),
            authority: proposal.authority,
            end_time: proposal.end_time,
        });

        Ok(())
    }

    pub fn init_cast_vote_comp_def(ctx: Context<InitCastVoteCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_reveal_tally_comp_def(ctx: Context<InitRevealTallyCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_init_tally_comp_def(ctx: Context<InitInitTallyCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_fetch_tally_comp_def(ctx: Context<InitFetchTallyCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_tally(
        ctx: Context<InitTally>,
        computation_offset: u64,
    ) -> Result<()> {
        let proposal = &ctx.accounts.proposal;

        // tally_nonce == [0; 16] means not yet initialized
        require!(
            proposal.tally_nonce == [0u8; 16],
            ErrorCode::TallyAlreadyInitialized
        );

        let tally = &proposal.encrypted_tally;
        let tally_nonce: u128 = 0;

        let args = ArgBuilder::new()
            .plaintext_u128(tally_nonce)
            .encrypted_u32(tally[0])
            .encrypted_u32(tally[1])
            .encrypted_u32(tally[2])
            .encrypted_u32(tally[3])
            .encrypted_u32(tally[4])
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![InitTallyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.proposal.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_tally")]
    pub fn init_tally_callback(
        ctx: Context<InitTallyCallback>,
        output: SignedComputationOutputs<InitTallyOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitTallyOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };

        let proposal = &mut ctx.accounts.proposal;
        for i in 0..5 {
            proposal.encrypted_tally[i] = o.ciphertexts[i];
        }
        proposal.tally_nonce = o.nonce.to_le_bytes();

        Ok(())
    }

    pub fn cast_vote(
        ctx: Context<CastVote>,
        computation_offset: u64,
        vote_ciphertext: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let proposal = &ctx.accounts.proposal;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp < proposal.end_time,
            ErrorCode::VotingEnded
        );
        require!(
            !ctx.accounts.vote_record.has_voted,
            ErrorCode::AlreadyVoted
        );
        require!(
            ctx.accounts.voter_token_account.amount >= proposal.min_token_amount,
            ErrorCode::InsufficientTokens
        );
        require!(
            ctx.accounts.voter_token_account.mint == proposal.required_token_mint,
            ErrorCode::WrongToken
        );

        ctx.accounts.vote_record.has_voted = true;
        ctx.accounts.vote_record.voter = ctx.accounts.voter.key();

        let tally_nonce = u128::from_le_bytes(proposal.tally_nonce);
        let tally = &proposal.encrypted_tally;

        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u8(vote_ciphertext)
            .plaintext_u128(tally_nonce)
            .encrypted_u32(tally[0])
            .encrypted_u32(tally[1])
            .encrypted_u32(tally[2])
            .encrypted_u32(tally[3])
            .encrypted_u32(tally[4])
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![CastVoteCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.proposal.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "cast_vote")]
    pub fn cast_vote_callback(
        ctx: Context<CastVoteCallback>,
        output: SignedComputationOutputs<CastVoteOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(CastVoteOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };

        let proposal = &mut ctx.accounts.proposal;
        for i in 0..5 {
            proposal.encrypted_tally[i] = o.ciphertexts[i];
        }
        proposal.tally_nonce = o.nonce.to_le_bytes();

        Ok(())
    }

    pub fn reveal_tally(
        ctx: Context<RevealTally>,
        computation_offset: u64,
    ) -> Result<()> {
        let proposal = &ctx.accounts.proposal;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp >= proposal.end_time,
            ErrorCode::VotingNotEnded
        );
        require!(!proposal.is_finalized, ErrorCode::AlreadyFinalized);

        let tally_nonce = u128::from_le_bytes(proposal.tally_nonce);
        let tally = &proposal.encrypted_tally;

        let args = ArgBuilder::new()
            .plaintext_u128(tally_nonce)
            .encrypted_u32(tally[0])
            .encrypted_u32(tally[1])
            .encrypted_u32(tally[2])
            .encrypted_u32(tally[3])
            .encrypted_u32(tally[4])
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealTallyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.proposal.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    pub fn fetch_tally(
        ctx: Context<FetchTally>,
        computation_offset: u64,
        requester_pubkey: [u8; 32],
        input_nonce: u128,
        dummy_data: [[u8; 32]; 5],
    ) -> Result<()> {
        let proposal = &ctx.accounts.proposal;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp >= proposal.end_time,
            ErrorCode::VotingNotEnded
        );
        require!(!proposal.is_finalized, ErrorCode::AlreadyFinalized);

        let tally_nonce = u128::from_le_bytes(proposal.tally_nonce);
        let tally = &proposal.encrypted_tally;

        let args = ArgBuilder::new()
            .x25519_pubkey(requester_pubkey)
            .plaintext_u128(input_nonce)
            .encrypted_u32(dummy_data[0])
            .encrypted_u32(dummy_data[1])
            .encrypted_u32(dummy_data[2])
            .encrypted_u32(dummy_data[3])
            .encrypted_u32(dummy_data[4])
            .plaintext_u128(tally_nonce)
            .encrypted_u32(tally[0])
            .encrypted_u32(tally[1])
            .encrypted_u32(tally[2])
            .encrypted_u32(tally[3])
            .encrypted_u32(tally[4])
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FetchTallyCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.proposal.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "fetch_tally")]
    pub fn fetch_tally_callback(
        ctx: Context<FetchTallyCallback>,
        output: SignedComputationOutputs<FetchTallyOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(FetchTallyOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };

        let proposal = &mut ctx.accounts.proposal;
        proposal.is_finalized = true;
        proposal.shared_tally_nonce = o.nonce.to_le_bytes();
        for i in 0..5 {
            proposal.shared_tally_data[i] = o.ciphertexts[i];
        }

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_tally")]
    pub fn reveal_tally_callback(
        ctx: Context<RevealTallyCallback>,
        output: SignedComputationOutputs<RevealTallyOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealTallyOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into());
            }
        };

        let proposal = &mut ctx.accounts.proposal;
        proposal.is_finalized = true;
        proposal.final_tally = [
            o.field_0 as u64,
            o.field_1 as u64,
            o.field_2 as u64,
            o.field_3 as u64,
            o.field_4 as u64,
        ];

        emit!(TallyRevealed {
            proposal: proposal.key(),
            tally: proposal.final_tally,
        });

        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub authority: Pubkey,
    #[max_len(100)]
    pub title: String,
    #[max_len(50)]
    pub option_0: String,
    #[max_len(50)]
    pub option_1: String,
    #[max_len(50)]
    pub option_2: String,
    #[max_len(50)]
    pub option_3: String,
    #[max_len(50)]
    pub option_4: String,
    pub start_time: i64,
    pub end_time: i64,
    pub required_token_mint: Pubkey,
    pub min_token_amount: u64,
    pub is_finalized: bool,
    pub tally_nonce: [u8; 16],
    pub encrypted_tally: [[u8; 32]; 5],
    pub final_tally: [u64; 5],
    pub bump: u8,
    pub shared_tally_nonce: [u8; 16],
    pub shared_tally_data: [[u8; 32]; 5],
}

#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    pub voter: Pubkey,
    pub has_voted: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(title: String)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [b"proposal", authority.key().as_ref(), title.as_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("cast_vote", payer)]
#[derive(Accounts)]
pub struct InitCastVoteCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("reveal_tally", payer)]
#[derive(Accounts)]
pub struct InitRevealTallyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("init_tally", payer)]
#[derive(Accounts)]
pub struct InitInitTallyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("init_tally", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct InitTally<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_TALLY))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("init_tally")]
#[derive(Accounts)]
pub struct InitTallyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

#[queue_computation_accounts("cast_vote", voter)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(mut)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(
        init_if_needed,
        payer = voter,
        space = 8 + VoteRecord::INIT_SPACE,
        seeds = [b"vote_record", proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub vote_record: Account<'info, VoteRecord>,
    #[account(
        associated_token::mint = proposal.required_token_mint,
        associated_token::authority = voter,
    )]
    pub voter_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = voter,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CAST_VOTE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("cast_vote")]
#[derive(Accounts)]
pub struct CastVoteCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CAST_VOTE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

#[queue_computation_accounts("reveal_tally", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RevealTally<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TALLY))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("reveal_tally")]
#[derive(Accounts)]
pub struct RevealTallyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

#[init_computation_definition_accounts("fetch_tally", payer)]
#[derive(Accounts)]
pub struct InitFetchTallyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("fetch_tally", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FetchTally<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FETCH_TALLY))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("fetch_tally")]
#[derive(Accounts)]
pub struct FetchTallyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FETCH_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

#[event]
pub struct ProposalCreated {
    pub proposal: Pubkey,
    pub title: String,
    pub authority: Pubkey,
    pub end_time: i64,
}

#[event]
pub struct TallyRevealed {
    pub proposal: Pubkey,
    pub tally: [u64; 5],
}

#[error_code]
pub enum ErrorCode {
    #[msg("Voting has already ended")]
    VotingEnded,
    #[msg("Voting has not ended yet")]
    VotingNotEnded,
    #[msg("You have already voted")]
    AlreadyVoted,
    #[msg("Insufficient token balance to vote")]
    InsufficientTokens,
    #[msg("Wrong token mint")]
    WrongToken,
    #[msg("Tally already finalized")]
    AlreadyFinalized,
    #[msg("Minimum voting duration is 10 minutes")]
    DurationTooShort,
    #[msg("Title is too long")]
    TitleTooLong,
    #[msg("The cluster is not set")]
    ClusterNotSet,
    #[msg("Computation was aborted")]
    AbortedComputation,
    #[msg("Tally is already initialized")]
    TallyAlreadyInitialized,
}
