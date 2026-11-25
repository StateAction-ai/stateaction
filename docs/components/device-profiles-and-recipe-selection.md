# Capture sources and recipe selection

SA-150 defines the staff recipe catalog and the capture-source admission rules.

## Goal

Researchers should not choose a recipe for every recording. The capture source and its format determine which recipes are valid. The system picks the default recipe automatically. A person is asked only when there is a real question.

## Concepts

- **Capture source.** A definition in code for the app or device that produces a recording and the format it produces. The only source today is `stateaction_mobile@1`, the StateAction mobile app for Android. It captures 1080p30 H.264 video, IMU and pose from live ARCore. Phone model, camera IDs, lens and other hardware evidence are attributes of individual recordings.
- **Recipe.** The processing configuration, including stages, models and parameters.
- **Default recipe.** The recipe a defined capture source starts with. The mobile mapping uses `indego_hosted_canary@1`, the recipe recorded by the seeded IndEgo jobs. The mobile signature and the public-video simulation are admitted through separate checks.

## How a capture source is matched

Match the sealed recording format, RGB profile and ten StateAction mobile channel declarations against the versioned definition in code. The sealed recording metadata provides device and camera IDs, lens, frame rate and pose evidence for inspection. Use that evidence to explain the match. A recording matches at most one capture source.

## What happens when a recording arrives

1. **Matching capture source with a default recipe.** Processing starts with that recipe if admission allows it.
2. **No matching capture source.** Hold the recording as **Needs setup** and explain the missing match. Add support by defining the source in code.
3. **Several supported recipes and no default.** Hold the recording as **Choose a recipe**. This is an example state while the single current source has a default.

Held recordings wait for a capture source or a recipe choice.

## Changing the recipe later

The recording page shows the recipe and its default capture source where applicable. The current mobile capture source has one supported recipe, so **Reprocess with another recipe** is disabled. A supported alternate recipe would start a new full run while retaining the earlier results and selections.

Before confirming, the page states the consequences. A different recipe can plan different clips. Clips already reviewed stay with the old result, and the new result's clips go to Pending Review. The confirm step shows how many clips are already reviewed, how many new ones will need review, and the estimated cost for information.

## Staff recipe catalog

| URL                    | Purpose                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/recipes`             | Visual recipe cards with processing flow, version, estimated cost per video-hour, supported capture sources, defaults and recording count                                     |
| `/recipes?tab=devices` | One StateAction mobile app capture-source card linked by a solid arrow to the default recipe. A placeholder explains that custom capture devices are defined in code.         |
| `/recipes/<recipeId>`  | Recipe definition, full flow, supported capture sources, defaults and links to recordings that used it. With a job parameter, show the exact admitted recipe and run details. |

The **Recipes** navigation item and pages are staff-only and read-only. Show “Recipes and capture sources are defined in code.” A recording with an unknown capture source shows **Needs setup**. Define the graph as planned data flow, and show actual measured execution separately when a job was recorded.

## Interface rules

- Show the current recipe once in the recording header. Flag a recipe version change at the run level. Recipe definitions remain accessible from the catalog and the recording link.
- Recipes and capture sources are available to staff.
- Settings has no device registration.

## Admission and provenance

- Capture source definitions and matching in code, with tests for the mobile app and the no-match case.
- Check supported capture source IDs and their default recipes at build time.
- Admission uses the match result to start processing or to hold the recording with a typed reason. This may need a new held state and an additive migration.
- Recording page: recipe display, reprocess action and its confirm step, held states.
