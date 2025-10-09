from opentrons import protocol_api

metadata = {
    "protocolName": "OT-2 Serial Dilution Tutorial (Single-Channel)",
    "author": "Opentrons Assistant",
    "description": "Distribute diluent to a 96-well plate, then perform 8 parallel serial dilutions across each row using sources from a 12-channel reservoir.",
    "apiLevel": "2.15",
}

def run(protocol: protocol_api.ProtocolContext):
    # User-adjustable parameters
    DILUENT_VOL = 50.0   # µL of diluent pre-loaded into each well
    TRANSFER_VOL = 30.0  # µL transferred at each serial dilution step
    MIX_REPS = 3
    MIX_VOL = 25.0       # µL for mixing after each transfer
    ASPIRATE_RATE = 1.0  # 1.0 = default rate
    DISPENSE_RATE = 1.0  # 1.0 = default rate

    # Deck setup (OT-2 slots are 1-11)
    plate = protocol.load_labware("corning_96_wellplate_360ul_flat", 1)  # 96-well plate
    tiprack_1 = protocol.load_labware("opentrons_96_tiprack_300ul", 2)
    tiprack_2 = protocol.load_labware("opentrons_96_tiprack_300ul", 3)
    reservoir = protocol.load_labware("usascientific_12_reservoir_22ml", 4)

    # Instruments
    p300 = protocol.load_instrument(
        instrument_name="p300_single_gen2",
        mount="left",
        tip_racks=[tiprack_1, tiprack_2],
    )

    # Reagent mapping in reservoir:
    # - A12 = diluent
    # - A1–A8 = 8 distinct stock solutions for rows A–H
    diluent = reservoir.wells_by_name()["A12"]
    sources = [reservoir.wells_by_name()[f"A{i}"] for i in range(1, 9)]  # A1..A8

    # Optional: set conservative speeds
    p300.flow_rate.aspirate = 94 * ASPIRATE_RATE   # default ~94 µL/s
    p300.flow_rate.dispense = 94 * DISPENSE_RATE   # default ~94 µL/s
    p300.flow_rate.blow_out = 300

    # 1) Distribute diluent to all wells (single tip for efficiency)
    p300.distribute(
        DILUENT_VOL,
        diluent,
        plate.wells(),       # all 96 wells in A1..H12 order
        disposal_volume=10,  # helps maintain accuracy with reservoirs
        new_tip="once"
    )

    # 2) Serial dilution across each row (A..H) using sources A1..A8
    # For each row:
    # - Add TRANSFER_VOL of stock to the first well
    # - Then serially transfer TRANSFER_VOL from column 1->2, 2->3, ... 11->12
    # - Mix after each dispense to homogenize
    for row_index, row in enumerate(plate.rows()):  # rows()[0]=A, ... rows()[7]=H
        source = sources[row_index]
        p300.pick_up_tip()

        # Seed first well in the row from reservoir stock
        p300.transfer(
            TRANSFER_VOL,
            source,
            row[0],
            mix_after=(MIX_REPS, MIX_VOL),
            new_tip="never"
        )

        # Serially pass TRANSFER_VOL down the row (1->2, 2->3, ..., 11->12)
        for col in range(0, 11):
            # Mix in the donor well before taking aliquot to improve homogeneity
            p300.mix(MIX_REPS, MIX_VOL, row[col])
            p300.transfer(
                TRANSFER_VOL,
                row[col],
                row[col + 1],
                mix_after=(MIX_REPS, MIX_VOL),
                new_tip="never"
            )

        p300.drop_tip()

    # Notes:
    # - Final volumes: well 1 ends ~50 µL, wells 2–12 end ~80 µL (due to serial pass).
    #   If you prefer constant volumes across all wells, add an extra step to remove
    #   TRANSFER_VOL from column 12 of each row after the last transfer.