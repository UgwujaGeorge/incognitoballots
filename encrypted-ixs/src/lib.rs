use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    #[derive(Copy, Clone)]
    pub struct VoteTally {
        option_0: u32,
        option_1: u32,
        option_2: u32,
        option_3: u32,
        option_4: u32,
    }

    #[instruction]
    pub fn cast_vote(
        vote_ctxt: Enc<Shared, u8>,
        tally_ctxt: Enc<Mxe, VoteTally>,
    ) -> Enc<Mxe, VoteTally> {
        let vote = vote_ctxt.to_arcis();
        let mut tally = tally_ctxt.to_arcis();

        tally.option_0 = tally.option_0 + if vote == 0 { 1u32 } else { 0u32 };
        tally.option_1 = tally.option_1 + if vote == 1 { 1u32 } else { 0u32 };
        tally.option_2 = tally.option_2 + if vote == 2 { 1u32 } else { 0u32 };
        tally.option_3 = tally.option_3 + if vote == 3 { 1u32 } else { 0u32 };
        tally.option_4 = tally.option_4 + if vote == 4 { 1u32 } else { 0u32 };

        tally_ctxt.owner.from_arcis(tally)
    }

    #[instruction]
    pub fn init_tally(
        tally_ctxt: Enc<Mxe, VoteTally>,
    ) -> Enc<Mxe, VoteTally> {
        let zero = VoteTally {
            option_0: 0u32,
            option_1: 0u32,
            option_2: 0u32,
            option_3: 0u32,
            option_4: 0u32,
        };
        tally_ctxt.owner.from_arcis(zero)
    }

    #[instruction]
    pub fn reveal_tally(
        tally_ctxt: Enc<Mxe, VoteTally>,
    ) -> (u32, u32, u32, u32, u32) {
        let tally = tally_ctxt.to_arcis();
        (
            tally.option_0.reveal(),
            tally.option_1.reveal(),
            tally.option_2.reveal(),
            tally.option_3.reveal(),
            tally.option_4.reveal(),
        )
    }

    #[instruction]
    pub fn fetch_tally(
        dummy_ctxt: Enc<Shared, VoteTally>,
        tally_ctxt: Enc<Mxe, VoteTally>,
    ) -> Enc<Shared, VoteTally> {
        let tally = tally_ctxt.to_arcis();
        dummy_ctxt.owner.from_arcis(tally)
    }
}
