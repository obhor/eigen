"""
Golden retrieval set (audit H19).

Builds a 12-page fact-planted PDF in memory, runs the real pipeline
(extract_pages → chunk_pages → embed → build_index → query_index), and reports
per-question gold rank, recall@5 and MRR. It sweeps MMR_LAMBDA (live) and holds
the retriever to a recall floor, so a re-tune that hurts retrieval fails here.

H19 outcome, frozen into rag/retriever.py: the old MIN_RRF_SCORE=0.02 threshold
sat between 1/RRF_K (0.0167) and 2/RRF_K (0.0333), so it dropped every
single-signal hit and leaned on a fallback to avoid returning nothing. This set
measured recall@5 1.000 and MRR 0.903 both at 0.02 and at 0.0 — a no-op that
could only lose results — so the threshold and its fallback were deleted. The
check pins that they stay deleted.

Manual run (loads all-MiniLM-L6-v2):
    cd eigen-rag/server && python check_retrieval_quality.py
"""
import fitz

from pdf.parser import extract_pages
from pdf.indexer import chunk_pages
from rag.embeddings import embed
from rag import retriever

K = 5
DOC = "check-quality"

# Sections 5 and 11 share a device name with near-identical values — the
# near-duplicate distractor pair. Every plant carries a unique `marker`.
SECTIONS = [
    {
        "n": 1, "topic": "Cryogenic cooling",
        "body": "The dilution refrigerator reaches base temperature after a two-day "
                "cooldown. Helium-3 circulation is monitored from the control rack, and "
                "the cold head is serviced every two thousand operating hours. Frost on "
                "the radiation shield is recorded in the shift log. The compressor skid "
                "draws roughly seven kilowatts during steady operation, and the oil "
                "separator is drained quarterly by the maintenance team.",
        "plant": "The cryo pump at the mixing chamber is driven at 8842 Hz.",
        "marker": "8842 Hz",
        "q": "What frequency is the cryo pump at the mixing chamber driven at?",
    },
    {
        "n": 2, "topic": "Membrane filtration",
        "body": "Feed water passes a sand filter before entering the membrane skid. "
                "Pressure differential across the cartridge is logged hourly, and the "
                "housing is backflushed when it exceeds one bar. Operators note that "
                "turbidity spikes after storms, so the intake is sampled more often in "
                "the monsoon season. Spent cartridges are autoclaved and returned to "
                "the supplier for inspection.",
        "plant": "The filtration membrane used in the water loop has a pore size of 0.22 micron.",
        "marker": "0.22 micron",
        "q": "How fine is the filtration membrane used in the water loop?",
    },
    {
        "n": 3, "topic": "Vacuum annealing",
        "body": "Green bodies are loaded into the graphite crucible and pumped down "
                "overnight. The controller ramps the chamber slowly to avoid thermal "
                "shock, then holds the setpoint while the getter material absorbs "
                "residual oxygen. Cooling is done under argon to prevent oxidation. "
                "The batch record lists the partial pressure at every stage, and any "
                "deviation above one decade voids the run.",
        "plant": "The vacuum furnace annealing cycle holds at 612 C for six hours.",
        "marker": "612 C",
        "q": "Which annealing temperature does the vacuum furnace hold at?",
    },
    {
        "n": 4, "topic": "Optics bench",
        "body": "The bench is floated on pneumatic isolators and aligned weekly with a "
                "shearing interferometer. Mirrors are mounted in kinematic holders so "
                "a realignment can be repeated without disturbing neighbouring paths. "
                "Beam dumps are placed at every unused port, and the lab requires "
                "laser goggles whenever the shutter is open. Alignment drifts are "
                "chased by walking the beam one optic at a time.",
        "plant": "The bench laser emits at a wavelength of 1064 nm.",
        "marker": "1064 nm",
        "q": "What wavelength does the bench laser emit at?",
    },
    {
        "n": 5, "topic": "Oscillator stability",
        "body": "Reference oscillators are kept in a temperature-controlled enclosure "
                "and compared against the lab standard every month. Phase noise is "
                "measured at several offset frequencies, and the Allan deviation is "
                "plotted from the counter logs. Cabling is kept short and shielded to "
                "avoid picking up the switching supplies on the same bench.",
        "plant": "The Marconi oscillator in section 5 is held at 3310 K.",
        "marker": "3310 K",
        "q": "Which temperature is the Marconi oscillator in section 5 held at?",
    },
    {
        "n": 6, "topic": "Ion implantation",
        "body": "Wafers are mounted on a rotating stage to spread the dose evenly. The "
                "beam current is trimmed before every cassette, and the end station "
                "keeps a running map of the implanted area. Photoresist is stripped "
                "afterwards in a downstream plasma etcher. Channeling is avoided by "
                "tilting the stage seven degrees away from the beam axis.",
        "plant": "The dopant ions are implanted with an energy of 40 keV.",
        "marker": "40 keV",
        "q": "How much energy is used to implant the dopant ions?",
    },
    {
        "n": 7, "topic": "Thermal cycling",
        "body": "Assemblies go through an environmental chamber that steps between hot "
                "and cold dwells. Transition rates are limited by the chamber's "
                "refrigeration capacity, so the profile is stretched at the cold end. "
                "Continuity is checked in situ to catch solder-joint failures early. "
                "Failed units are cross-sectioned and photographed for the failure "
                "analysis report.",
        "plant": "The assembly survived 1275 thermal cycles before the first open circuit.",
        "marker": "1275 thermal cycles",
        "q": "How many thermal cycles did the assembly survive?",
    },
    {
        "n": 8, "topic": "Chromatography",
        "body": "The column is equilibrated with mobile phase before each batch. "
                "Fractions are collected in a chilled tray and analysed the same day. "
                "Backpressure rises as the resin compresses, so the bed is repacked "
                "when the trace starts to tail. Method blanks run every ten samples "
                "to catch carryover from the previous injection.",
        "plant": "The eluent moves through the column at a flow rate of 3.5 mL/min.",
        "marker": "3.5 mL/min",
        "q": "What flow rate moves the eluent through the column?",
    },
    {
        "n": 9, "topic": "Motion feedback",
        "body": "Rotary stages are closed around an incremental encoder on the rear "
                "shaft. The drive interpolates between counts, so resolution at the "
                "load depends on the gear ratio. Index pulses are used to re-home the "
                "stage after a power interruption. Cable shields are bonded to the "
                "chassis at both ends to keep the drive from tripping on noise.",
        "plant": "The optical encoder produces 4096 pulses per revolution.",
        "marker": "4096 pulses",
        "q": "How many pulses per revolution does the optical encoder produce?",
    },
    {
        "n": 10, "topic": "Acoustic treatment",
        "body": "The test cell is lined with absorber panels behind a perforated skin. "
                "Reverberation time is measured with a burst of pink noise before and "
                "after each change to the lining. Machinery mounts are swapped for "
                "softer durometer when structure-borne noise dominates. The operator "
                "station sits outside the room, behind a laminated observation window.",
        "plant": "The acoustic dampers remove up to 38 dB of structure-borne noise.",
        "marker": "38 dB",
        "q": "How much structure-borne noise do the acoustic dampers remove?",
    },
    {
        "n": 11, "topic": "Oscillator enclosure",
        "body": "A second reference oscillator is installed on the upper shelf of the "
                "same rack. Its enclosure is flushed with dry nitrogen to keep the "
                "crystal free of condensation during the humid months. The weekly "
                "comparison against the lab standard is logged in the same workbook "
                "as the downstairs unit, and drift beyond one part in ten to the "
                "eighth is escalated to the metrology group.",
        "plant": "The Marconi oscillator in section 11 is held at 3312 K.",
        "marker": "3312 K",
        "q": "Which temperature is the Marconi oscillator in section 11 held at?",
    },
    {
        "n": 12, "topic": "Power conditioning",
        "body": "The rack accepts a wide input range and regulates it through a "
                "switching stage followed by a linear post-regulator. Inrush is "
                "limited by a thermistor that is bypassed by a relay after startup. "
                "Output ripple is measured with a differential probe, never with a "
                "clip lead, to keep the ground loop out of the reading.",
        "plant": "The power conditioning stage delivers 48 V to the bus.",
        "marker": "48 V",
        "q": "What voltage does the power conditioning stage deliver to the bus?",
    },
]


# A second paragraph per section, so each page yields several chunks and the
# fixture is big enough for single-signal candidates to exist at all
# (with n <= k*3 every chunk is ranked by both retrievers and the threshold
# can never fire — see the H19 measurement below).
NOTES = {
    1: "The pulse-tube pre-cooler runs on the same compressor loop and is brought "
       "online first. Temperature is logged from four sensors: two on the cold "
       "plate, one on the mixing chamber flange and one on the radiation shield. A "
       "slow warm-up is scheduled every six months so the indium seals can be "
       "inspected and replaced. Any pressure rise in the return line is treated as "
       "a blocked filter until it is proven otherwise.",
    2: "Cartridge part numbers are recorded so a change in supplier can be traced "
       "back to a batch. The permeate is sampled for conductivity, which rises "
       "sharply the moment the membrane fails. Cleaning is done with a caustic wash "
       "followed by a short rinse, and the waste is neutralised before it goes to "
       "drain. The skid is drained and winterised before the plant shutdown.",
    3: "The diffusion pump is isolated behind a cold trap to keep oil vapour out of "
       "the hot zone. A leak check with helium is run after every crucible change, "
       "and the result is filed with the batch record. Thermocouples are replaced "
       "whenever their reading drifts from the reference during the soak. Power is "
       "delivered through water-cooled feedthroughs, which are inspected for "
       "pitting each quarter.",
    4: "The spatial filter is set once and left alone; adjusting it without a target "
       "is how alignment sessions go wrong. Fringes are counted rather than guessed, "
       "and the results are written on the whiteboard beside the bench. Protective "
       "caps go on every port that is not in use, and the room is kept at a steady "
       "temperature so the mounts do not creep overnight.",
    5: "Drift is quoted as a fraction of the carrier over one second and over one "
       "day. The distribution amplifier feeding the reference is mounted in the same "
       "enclosure to avoid thermal gradients along the coax. Calibration certificates "
       "are kept for five years, and any unit that fails the comparison is taken out "
       "of service until it is repaired.",
    6: "The source is conditioned for half an hour before the first wafer so the arc "
       "strikes cleanly. Dose uniformity is verified by measuring sheet resistance "
       "across a monitor wafer at five points. Vacuum interlocks prevent the beam "
       "from running when the chamber pressure rises, and the residual gas analyser "
       "trace is archived with the run.",
    7: "Chamber calibration is verified with an independent thermocouple before each "
       "campaign. Dwell times are long enough for the fixture to reach the setpoint "
       "but are not counted in the cycle total. Units are powered during the cold "
       "step so intermittent faults are caught, and the data logger samples every "
       "channel once a minute.",
    8: "The column is stored in the same solvent it is run with, and never left dry. "
       "Peak purity is checked with a diode array before the fractions are pooled. "
       "Retention times are compared against the reference run, and a shift beyond "
       "two percent triggers a new calibration. Waste lines are labelled and "
       "collected separately.",
    9: "The drive is tuned after the encoder is mounted, not before, because the loop "
       "gain depends on the count resolution. Backlash is measured by approaching a "
       "position from both directions and halving the difference. Homing speed is "
       "kept low so the index pulse cannot be skipped, and the limit switches are "
       "wired normally closed.",
    10: "Panels are rated by their absorption coefficient, and the mounting depth "
        "matters as much as the material. Noise paths are traced by covering suspect "
        "panels with a blanket and watching the meter. The room is re-measured after "
        "any new conduit penetrates the wall. Ear defenders are issued at the door, "
        "and the meter reading at the operator station is posted daily.",
    11: "Rack airflow is directed from the bottom shelf upwards so the upper unit "
        "does not sit in the exhaust of the one below. Cables are strain-relieved at "
        "the frame, and the enclosure lid carries a tamper seal that is broken only "
        "for scheduled work. The log sheet for both units is reviewed monthly by the "
        "metrology group.",
    12: "The linear stage is the limiting element for efficiency, so the preregulator "
        "is adjusted to keep its headroom small. Hold-up capacitors are discharged "
        "through a bleeder, and the rack is left to sit before any work inside. "
        "Fusing is selected for the wiring rather than the load, and every output "
        "pair is checked for polarity before the bus is energised.",
}


def _pdf_bytes() -> bytes:
    doc = fitz.open()
    for s in SECTIONS:
        page = doc.new_page()
        text = f"Section {s['n']}: {s['topic']}\n\n{s['body']}\n{NOTES[s['n']]}\n{s['plant']}"
        rc = page.insert_textbox(fitz.Rect(50, 50, 545, 790), text, fontsize=10)
        assert rc >= 0, f"section {s['n']} does not fit its page"
    data = doc.tobytes()
    doc.close()
    return data


def _rank(results, marker: str) -> int:
    for i, r in enumerate(results, 1):
        if marker in r["text"]:
            return i
    return 0


def measure(lam: float):
    retriever.MMR_LAMBDA = lam
    ranks, counts = [], []
    for s in SECTIONS:
        res = retriever.query_index(DOC, embed([s["q"]]), s["q"], K)
        counts.append(len(res))
        ranks.append(_rank(res, s["marker"]))
    recall = sum(1 for r in ranks if r) / len(ranks)
    mrr = sum(1 / r for r in ranks if r) / len(ranks)
    return recall, mrr, sum(counts) / len(counts), ranks


pages = extract_pages(_pdf_bytes())
assert len(pages) == 12, len(pages)
chunks = chunk_pages(pages)
vecs = embed([c["text"] for c in chunks])
retriever.build_index(DOC, chunks, vecs)
print(f"fixture: {len(pages)} pages, {len(chunks)} chunks, top_k={min(K * 3, len(chunks))}, "
      f"k={K}; MMR_LAMBDA={retriever.MMR_LAMBDA}")
print(f"H19: 1/RRF_K = {1 / retriever.RRF_K:.4f} < the deleted 0.02 < 2/RRF_K = "
      f"{2 / retriever.RRF_K:.4f} — it only ever separated single- from double-signal hits\n")
assert not hasattr(retriever, "MIN_RRF_SCORE"), \
    "the H19 threshold must stay deleted — it measured as a pure no-op"

results = {}
for lam in (0.7, 1.0):
    recall, mrr, avg, ranks = measure(lam)
    results[lam] = (recall, mrr, avg, ranks)
    print(f"  MMR_LAMBDA={lam:<4} recall@5={recall:.3f}  MRR={mrr:.3f}  "
          f"avg results={avg:.1f}")

base = results[0.7]
best = max(results.items(), key=lambda kv: (kv[1][0], kv[1][1]))
print("\nper-question gold rank at the shipped setting (MMR_LAMBDA=0.7):")
for s, r in zip(SECTIONS, base[3]):
    flag = "  <-- MISSED" if not r else (f"  (rank {r})" if r > 1 else "")
    print(f"  section {s['n']:>2}: gold rank {r}{flag}")

# A fixture nobody can retrieve would make the numbers above meaningless.
assert base[0] >= 0.8, f"recall@5 {base[0]:.3f} — retrieval regressed"
print(f"\nbest setting by (recall@5, MRR): MMR_LAMBDA={best[0]} "
      f"recall@5={best[1][0]:.3f} MRR={best[1][1]:.3f}")

retriever.MMR_LAMBDA = 0.7
retriever._stores.pop(DOC, None)
