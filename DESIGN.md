# PolCam operator workspace

The application uses a light, stable control surface for operators examining detailed imagery. Opaque white panels hold readable text against changing maps. The map itself remains unchanged and unmasked.

## Identity

The public WB/PolCam website supplies the visual reference: navy #1a3077, blue #1072b2, white and cool neutral fields, Roboto Condensed, rectangular controls. These are observations of the official website, not a claim to a formal brand manual. Sources: https://www.wbgroup.pl/polcam/ and https://www.wbgroup.pl/app/themes/wbgroup/dist/styles/main_b136fadc.css.

The authentic color PolCam/WB logo sits in the top application bar. Roboto Condensed is self-hosted from Google Fonts under the SIL Open Font License included with the font. UI text uses the same family with tabular numerals for telemetry. Navy identifies selected actions; amber and source-specific colors remain available for meaningful map states.

## Layout and components

A 64 px application bar contains identity and map actions. A fixed left rail holds data sources and scenes; the right rail holds display, CCTV and context. Each rail scrolls independently without hiding collapsed siblings. Rectangular buttons have 2 px corners, a visible keyboard focus ring, and explicit selected states. On small screens, collapsed rails share the width; an opened panel uses the available width. Location, voice and visual presets retain a central bottom command strip. Source attribution remains visible, including clean and recording modes.

The PolCam HUD shows map context and a compact lower strip of coordinates, camera-derived altitude/angle and UTC. It does not claim a classified feed, satellite mission or recording state. Minimal hides context and secondary metrics; operator adds stronger context separation. A chosen simulation filter remains separate from the permanently removed circular Scope mask.

## Direction contract

THESIS: a legible map workstation specific to PolCam, replacing floating sci-fi pills and peripheral visual effects.
OWN-WORLD: white rectangular control surfaces, navy identity, blue interaction, Roboto Condensed and restrained separators.
STORY: select data, inspect source-backed objects, move across places, prepare a presentation.
FIRST VIEWPORT: anchored application bar; independently scrolling left sources and right inspector; unobstructed central map; central commands and lower telemetry.
FORM: seed: none (pinned). Owner: “UI żeby pasował do stylu WB Group”; the conversation supplies the product and identity direction.
FINISH: render and exercise desktop and mobile views, preserve attribution and keyboard controls, validate old-link mask removal, document actual test outcomes.
