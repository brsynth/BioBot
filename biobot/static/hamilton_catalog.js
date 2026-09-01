/**
 * hamilton_catalog.js — Hamilton STAR hardware catalog
 *
 * Carriers, labware, tips, and channel configurations for the Hamilton STAR line.
 */

const HAMILTON_CATALOG = {

  carriers: {
    "Tip Carriers": [
      { id: "TIP_CAR_480_A00",     name: "Tip Carrier 480 (5 positions)",       positions: 5, tracks: 6, type: "tip" },
      { id: "TIP_CAR_480_BC_A00",  name: "Tip Carrier 480 Barcode",             positions: 5, tracks: 6, type: "tip" },
      { id: "TIP_CAR_288_A00",     name: "Tip Carrier 288 (3 positions)",       positions: 3, tracks: 6, type: "tip" },
      { id: "TIP_CAR_NTR_A00",     name: "Nested Tip Rack Carrier",             positions: 3, tracks: 6, type: "tip" },
    ],
    "Plate Carriers": [
      { id: "PLT_CAR_L5AC_A00",    name: "Plate Carrier 5 positions (landscape)", positions: 5, tracks: 6, type: "plate" },
      { id: "PLT_CAR_P3AC_A00",    name: "Plate Carrier 3 positions (portrait)",  positions: 3, tracks: 4, type: "plate" },
      { id: "PLT_CAR_L5MD_A00",    name: "Plate Carrier 5 pos (multidispense)",   positions: 5, tracks: 6, type: "plate" },
      { id: "PLT_CAR_L5PCR_A00",   name: "PCR Plate Carrier 5 positions",         positions: 5, tracks: 6, type: "plate" },
    ],
    "Tube Carriers": [
      { id: "TUBE_CAR_24_A00",     name: "Tube Carrier 24 positions",           positions: 1, tracks: 3, type: "tube" },
      { id: "TUBE_CAR_32_A00",     name: "Tube Carrier 32 positions",           positions: 1, tracks: 1, type: "tube" },
    ],
    "Trough/Reservoir Carriers": [
      { id: "RGT_CAR_3R_A00",      name: "Reagent Carrier 3 troughs",           positions: 3, tracks: 6, type: "reservoir" },
      { id: "RGT_CAR_4R_A00",      name: "Reagent Carrier 4 troughs",           positions: 4, tracks: 6, type: "reservoir" },
    ],
    "Special Carriers": [
      { id: "TRASH_CAR_A00",       name: "Waste/Trash Carrier",                 positions: 1, tracks: 3, type: "trash" },
      { id: "WASH_CAR_A00",        name: "Wash Station Carrier",                positions: 1, tracks: 3, type: "wash" },
    ],
  },

  labware: {
    "Tip Racks": [
      { id: "hamilton_96_tiprack_50uL",             name: "50 µL CO-RE Tips",         wells: 96 },
      { id: "hamilton_96_tiprack_300uL",            name: "300 µL CO-RE Tips",        wells: 96 },
      { id: "hamilton_96_tiprack_1000uL",           name: "1000 µL CO-RE Tips",       wells: 96 },
      { id: "hamilton_96_tiprack_50uL_filter",      name: "50 µL CO-RE Filter Tips",  wells: 96 },
      { id: "hamilton_96_tiprack_300uL_filter",     name: "300 µL CO-RE Filter Tips", wells: 96 },
      { id: "hamilton_96_tiprack_1000uL_filter",    name: "1000 µL CO-RE Filter Tips", wells: 96 },
      { id: "hamilton_96_tiprack_5mL",              name: "5 mL CO-RE Tips",          wells: 96 },
    ],
    "Well Plates": [
      { id: "Cor_96_wellplate_360ul_Fb",            name: "Corning 96 Flat Bottom (360 µL)", wells: 96 },
      { id: "Cos_96_wellplate_200ul_Rb",            name: "Costar 96 Round Bottom (200 µL)", wells: 96 },
      { id: "Cos_96_PCR_200ul",                     name: "96 PCR Plate (200 µL)",    wells: 96 },
      { id: "Cos_384_wellplate_50ul",               name: "384-well plate (50 µL)",   wells: 384 },
      { id: "Cos_96_DW_1mL",                        name: "96 Deep Well (1 mL)",      wells: 96 },
      { id: "Cos_96_DW_2mL",                        name: "96 Deep Well (2 mL)",      wells: 96 },
    ],
    "Reservoirs / Troughs": [
      { id: "Hamilton_1_trough_300mL",              name: "Hamilton Trough (300 mL)",  wells: 1 },
      { id: "Hamilton_8_trough_30mL",               name: "Hamilton 8-Row Trough (30 mL)", wells: 8 },
      { id: "Nunc_96_trough_2mL",                   name: "Nunc 96 Trough (2 mL)",    wells: 96 },
    ],
  },

  channels: [
    { id: "8x1mL",      name: "8 × 1 mL Channels",      count: 8, volume: "1-1000 µL" },
    { id: "16x1mL",     name: "16 × 1 mL Channels",     count: 16, volume: "1-1000 µL" },
    { id: "8x5mL",      name: "8 × 5 mL Channels",      count: 8, volume: "50-5000 µL" },
    { id: "core96",     name: "CO-RE 96 Probe Head",     count: 96, volume: "1-1000 µL" },
    { id: "mp384",      name: "384 Multi-Probe Head",    count: 384, volume: "0.5-30 µL" },
  ],
};

// Display name lookup
const HAMILTON_CARRIER_NAMES = {};
for (const [cat, items] of Object.entries(HAMILTON_CATALOG.carriers)) {
  for (const item of items) {
    HAMILTON_CARRIER_NAMES[item.id] = item.name;
  }
}

const HAMILTON_LABWARE_NAMES = {};
for (const [cat, items] of Object.entries(HAMILTON_CATALOG.labware)) {
  for (const item of items) {
    HAMILTON_LABWARE_NAMES[item.id] = item.name;
  }
}