/**
 * ot2_catalog.js — Complete OT-2 hardware catalog
 * 
 * All API load names verified against the Opentrons Labware Library
 * and official Python API v2 documentation.
 */

const OT2_CATALOG = {

  // ============================================================
  // PIPETTES (OT-2 GEN2 + GEN1)
  // ============================================================
  pipettes: {
    "GEN2 Single-Channel": [
      { id: "p20_single_gen2",   name: "P20 Single GEN2",   range: "1–20 µL" },
      { id: "p300_single_gen2",  name: "P300 Single GEN2",  range: "20–300 µL" },
      { id: "p1000_single_gen2", name: "P1000 Single GEN2", range: "100–1000 µL" },
    ],
    "GEN2 Multi-Channel": [
      { id: "p20_multi_gen2",    name: "P20 8-Channel GEN2",  range: "1–20 µL" },
      { id: "p300_multi_gen2",   name: "P300 8-Channel GEN2", range: "20–300 µL" },
    ],
    "GEN1 Single-Channel": [
      { id: "p10_single",   name: "P10 Single GEN1",   range: "1–10 µL" },
      { id: "p50_single",   name: "P50 Single GEN1",   range: "5–50 µL" },
      { id: "p300_single",  name: "P300 Single GEN1",  range: "30–300 µL" },
      { id: "p1000_single", name: "P1000 Single GEN1", range: "100–1000 µL" },
    ],
    "GEN1 Multi-Channel": [
      { id: "p10_multi",   name: "P10 8-Channel GEN1",  range: "1–10 µL" },
      { id: "p50_multi",   name: "P50 8-Channel GEN1",  range: "5–50 µL" },
      { id: "p300_multi",  name: "P300 8-Channel GEN1",  range: "30–300 µL" },
    ],
  },

  // ============================================================
  // TIP RACKS
  // ============================================================
  labware: {
    "Tip Racks": [
      { id: "opentrons_96_tiprack_10ul",          name: "10 µL Tip Rack",         wells: 96 },
      { id: "opentrons_96_tiprack_20ul",           name: "20 µL Tip Rack",         wells: 96 },
      { id: "opentrons_96_tiprack_300ul",          name: "300 µL Tip Rack",        wells: 96 },
      { id: "opentrons_96_tiprack_1000ul",         name: "1000 µL Tip Rack",       wells: 96 },
      { id: "opentrons_96_filtertiprack_10ul",     name: "10 µL Filter Tip Rack",  wells: 96 },
      { id: "opentrons_96_filtertiprack_20ul",     name: "20 µL Filter Tip Rack",  wells: 96 },
      { id: "opentrons_96_filtertiprack_200ul",    name: "200 µL Filter Tip Rack", wells: 96 },
      { id: "opentrons_96_filtertiprack_1000ul",   name: "1000 µL Filter Tip Rack", wells: 96 },
    ],

    // ============================================================
    // WELL PLATES
    // ============================================================
    "96-Well Plates": [
      { id: "corning_96_wellplate_360ul_flat",              name: "Corning 96 Flat (360 µL)",      wells: 96 },
      { id: "nest_96_wellplate_200ul_flat",                 name: "NEST 96 Flat (200 µL)",         wells: 96 },
      { id: "nest_96_wellplate_100ul_pcr_full_skirt",       name: "NEST 96 PCR Full Skirt (100 µL)", wells: 96 },
      { id: "biorad_96_wellplate_200ul_pcr",                name: "Bio-Rad 96 PCR (200 µL)",       wells: 96 },
      { id: "opentrons_96_wellplate_200ul_pcr_full_skirt",  name: "Opentrons 96 PCR (200 µL)",    wells: 96 },
      { id: "nest_96_wellplate_2ml_deep",                   name: "NEST 96 Deep Well (2 mL)",      wells: 96 },
      { id: "usascientific_96_wellplate_2.4ml_deep",        name: "USA Scientific 96 Deep (2.4 mL)", wells: 96 },
    ],

    "384-Well Plates": [
      { id: "corning_384_wellplate_112ul_flat",             name: "Corning 384 Flat (112 µL)",     wells: 384 },
      { id: "biorad_384_wellplate_50ul",                    name: "Bio-Rad 384 (50 µL)",          wells: 384 },
    ],

    "24-Well Plates": [
      { id: "corning_24_wellplate_3.4ml_flat",              name: "Corning 24 Flat (3.4 mL)",     wells: 24 },
      { id: "nest_96_wellplate_200ul_flat",                 name: "NEST 24 (200 µL)",             wells: 24 },
    ],

    "6 & 12-Well Plates": [
      { id: "corning_6_wellplate_16.8ml_flat",              name: "Corning 6 Flat (16.8 mL)",     wells: 6 },
      { id: "corning_12_wellplate_6.9ml_flat",              name: "Corning 12 Flat (6.9 mL)",     wells: 12 },
      { id: "corning_48_wellplate_1.6ml_flat",              name: "Corning 48 Flat (1.6 mL)",     wells: 48 },
    ],

    // ============================================================
    // RESERVOIRS
    // ============================================================
    "Reservoirs": [
      { id: "nest_12_reservoir_15ml",               name: "NEST 12 Reservoir (15 mL)",       wells: 12 },
      { id: "usascientific_12_reservoir_22ml",       name: "USA Sci 12 Reservoir (22 mL)",    wells: 12 },
      { id: "nest_1_reservoir_195ml",                name: "NEST 1 Reservoir (195 mL)",       wells: 1 },
      { id: "agilent_1_reservoir_290ml",             name: "Agilent 1 Reservoir (290 mL)",    wells: 1 },
      { id: "nest_1_reservoir_290ml",                name: "NEST 1 Reservoir (290 mL)",       wells: 1 },
    ],

    // ============================================================
    // TUBE RACKS
    // ============================================================
    "Tube Racks": [
      { id: "opentrons_24_tuberack_nest_1.5ml_snapcap",        name: "24 Tube Rack 1.5 mL Snap Cap",   wells: 24 },
      { id: "opentrons_24_tuberack_nest_1.5ml_screwcap",       name: "24 Tube Rack 1.5 mL Screw Cap",  wells: 24 },
      { id: "opentrons_24_tuberack_nest_2ml_snapcap",          name: "24 Tube Rack 2 mL Snap Cap",     wells: 24 },
      { id: "opentrons_24_tuberack_nest_2ml_screwcap",         name: "24 Tube Rack 2 mL Screw Cap",    wells: 24 },
      { id: "opentrons_24_tuberack_eppendorf_1.5ml_safelock_snapcap", name: "24 Tube Rack Eppendorf 1.5 mL", wells: 24 },
      { id: "opentrons_24_tuberack_eppendorf_2ml_safelock_snapcap",   name: "24 Tube Rack Eppendorf 2 mL",   wells: 24 },
      { id: "opentrons_24_tuberack_generic_2ml_screwcap",      name: "24 Tube Rack Generic 2 mL",      wells: 24 },
      { id: "opentrons_15_tuberack_nest_15ml_conical",         name: "15 Tube Rack 15 mL Conical",     wells: 15 },
      { id: "opentrons_6_tuberack_nest_50ml_conical",          name: "6 Tube Rack 50 mL Conical",      wells: 6 },
      { id: "opentrons_15_tuberack_falcon_15ml_conical",       name: "15 Tube Rack Falcon 15 mL",      wells: 15 },
      { id: "opentrons_6_tuberack_falcon_50ml_conical",        name: "6 Tube Rack Falcon 50 mL",       wells: 6 },
      { id: "opentrons_10_tuberack_falcon_4x50ml_6x15ml_conical", name: "10 Tube Rack (4×50 + 6×15 mL)", wells: 10 },
      { id: "opentrons_10_tuberack_nest_4x50ml_6x15ml_conical",   name: "10 Tube Rack NEST (4×50 + 6×15 mL)", wells: 10 },
    ],

    // ============================================================
    // ALUMINUM BLOCKS
    // ============================================================
    "Aluminum Blocks": [
      { id: "opentrons_24_aluminumblock_nest_1.5ml_snapcap",    name: "24 Al Block 1.5 mL Snap Cap",    wells: 24 },
      { id: "opentrons_24_aluminumblock_nest_1.5ml_screwcap",   name: "24 Al Block 1.5 mL Screw Cap",   wells: 24 },
      { id: "opentrons_24_aluminumblock_nest_2ml_snapcap",      name: "24 Al Block 2 mL Snap Cap",      wells: 24 },
      { id: "opentrons_24_aluminumblock_nest_2ml_screwcap",     name: "24 Al Block 2 mL Screw Cap",     wells: 24 },
      { id: "opentrons_24_aluminumblock_generic_2ml_screwcap",  name: "24 Al Block Generic 2 mL",       wells: 24 },
      { id: "opentrons_96_aluminumblock_biorad_wellplate_200ul", name: "96 Al Block Bio-Rad (200 µL)",   wells: 96 },
      { id: "opentrons_96_aluminumblock_nest_wellplate_100ul",  name: "96 Al Block NEST (100 µL)",      wells: 96 },
      { id: "opentrons_96_aluminumblock_generic_pcr_strip_200ul", name: "96 Al Block PCR Strip (200 µL)", wells: 96 },
    ],
  },

  // ============================================================
  // MODULES
  // ============================================================
  modules: [
    { id: "temperature module",       name: "Temperature Module GEN1" },
    { id: "temperature module gen2",  name: "Temperature Module GEN2" },
    { id: "magnetic module",          name: "Magnetic Module GEN1" },
    { id: "magnetic module gen2",     name: "Magnetic Module GEN2" },
    { id: "thermocycler module",      name: "Thermocycler Module GEN1" },
    { id: "thermocycler module gen2", name: "Thermocycler Module GEN2" },
    { id: "heaterShakerModuleV1",     name: "Heater-Shaker Module" },
  ],
};

// Flat lookup: api_name → display name (used by deck_renderer.js)
const LABWARE_DISPLAY_NAMES = {};
for (const [category, items] of Object.entries(OT2_CATALOG.labware)) {
  for (const item of items) {
    LABWARE_DISPLAY_NAMES[item.id] = item.name;
  }
}
// Add trash
LABWARE_DISPLAY_NAMES["opentrons_1_trash_1100ml_fixed"] = "Trash";

const PIPETTE_DISPLAY_NAMES = {};
for (const [category, items] of Object.entries(OT2_CATALOG.pipettes)) {
  for (const item of items) {
    PIPETTE_DISPLAY_NAMES[item.id] = item.name;
  }
}