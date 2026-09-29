/**
 * Check 13 - modality_claims (zero requests)
 *
 * Three sources can disagree about whether a model accepts images:
 *
 *   1. what the model page **describes**  — marketing prose,
 *   2. what the catalog **lists**         — `architecture.modality`,
 *   3. what the endpoint actually **does** — measured by the `vision` check.
 *
 * Only the third is evidence. The first two are the same publisher's claims
 * about the same publisher, which makes them correlated rather than
 * corroborating: a catalog can be confidently, consistently wrong, and when it
 * is, the router is the thing that finds out.
 *
 * This costs nothing. It reads facts the other checks already established, and
 * it reports a disagreement rather than resolving it — resolving it requires
 * sending an image, which is `vision`'s job and is opt-in.
 *
 * The asymmetry that matters: "lists image, measures fail" is far worse than
 * "lists text, measures nothing". The first sends real images to an endpoint
 * that will describe something else in their place.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { pass, skipped, type ResultInit } from './_helpers.js';
import type { CheckResult, Finding, Metrics } from '../types.js';

/** Wording that means "this model can see". Kept narrow to avoid false hits. */
const IMAGE_CLAIM = /\b(multimodal|image (input|input support|understanding)|vision[- ]language|accepts? images?|visual (input|understanding)|photo(graph)? input)\b/i;
const VIDEO_CLAIM = /\b(video input|video understanding|accepts? video)\b/i;

export default defineCheck({
  name: 'modality_claims',
  title: 'Modality claims',
  description: 'Compares the description, the listed modality, and what the vision check measured.',
  requests: 0,
  defaultTimeoutMs: 5_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'modality_claims';
    const title = 'Modality claims';

    const description = ctx.facts.catalogDescription;
    const modality = ctx.facts.catalogModality;
    const inputs = ctx.facts.catalogInputModalities;
    const measured = ctx.facts.visionVerdict;

    if (modality === undefined && description === undefined) {
      return skipped(
        name,
        title,
        'not run: the catalog entry carries no description and no architecture block, so there are no claims to compare',
        { metrics: { catalog_description: false, catalog_modality: false } },
      );
    }

    const claimsImage = description ? IMAGE_CLAIM.test(description) : false;
    const claimsVideo = description ? VIDEO_CLAIM.test(description) : false;
    const listed = parseModality(modality, inputs);
    const listsImage = listed.includes('image');
    const listsVideo = listed.includes('video');

    const metrics: Metrics = {
      description_present: description !== undefined,
      description_claims_image: description ? claimsImage : null,
      description_claims_video: description ? claimsVideo : null,
      listed_modality: modality ?? null,
      listed_input_modalities: inputs?.join(',') ?? null,
      lists_image: listsImage,
      lists_video: listsVideo,
      measured: measured ?? 'not measured',
      agreement: null,
    };

    const findings: Finding[] = [];

    // Description vs catalog.
    if (claimsImage && !listsImage) {
      findings.push(
        finding(
          name,
          'modality_claim_vs_list',
          'Description claims image input the catalog does not list',
          `the model page says "${excerpt(description!, IMAGE_CLAIM)}" but architecture.modality is ` +
            `"${modality ?? 'absent'}" with input_modalities [${inputs?.join(',') ?? 'absent'}]` +
            (measured ? `, and the vision check measured ${measured}` : ', and the vision check has not run'),
          'the publisher is contradicting itself in its own metadata, so a router that sizes capability off either field is guessing; the description is prose and the modality field is the one clients actually read',
          {
            listed_modality: modality ?? null,
            input_modalities: inputs?.join(',') ?? null,
            measured: measured ?? 'not measured',
          },
        ),
      );
      metrics.agreement = 'description-vs-catalog';
    } else if (!claimsImage && listsImage) {
      findings.push(
        finding(
          name,
          'modality_understated_in_prose',
          'Catalog lists image input the description never mentions',
          `architecture.modality is "${modality}" with input_modalities [${inputs?.join(',')}], but the ` +
            'description does not claim image support' +
            (measured ? `, and the vision check measured ${measured}` : ', and the vision check has not run'),
          'the capability is real but undiscoverable from the prose, so a router reading descriptions instead of structured fields will wrongly route image traffic elsewhere',
          { listed_modality: modality ?? null, measured: measured ?? 'not measured' },
        ),
      );
      metrics.agreement = 'catalog-vs-description';
    }

    // Catalog vs measurement. This is the one that bites.
    if (measured && listsImage && (measured === 'fail' || measured === 'inconclusive')) {
      // A fail and an inconclusive are not the same claim. "The model looked
      // and got it wrong" is evidence it is not looking; "the reply was
      // neither yes nor no" is an absence of evidence, and must not be
      // reported as if it were the same thing.
      const inference =
        measured === 'fail'
          ? 'the endpoint accepts the request but does not look at the image, so a caller gets a confident description of something else with nothing in the response to signal the difference; routing image traffic here is worse than routing it nowhere'
          : 'the reply was neither yes nor no, so this is an absence of evidence rather than a demonstration: image handling is unconfirmed, and the catalog claim is neither confirmed nor refuted';
      findings.push(
        finding(
          name,
          'modality_list_vs_measured',
          measured === 'fail'
            ? 'Catalog lists image input, measurement disagrees'
            : 'Catalog lists image input, measurement inconclusive',
          `architecture.modality is "${modality}" with input_modalities [${inputs?.join(',')}], but the vision ` +
            `check measured ${measured} against a generated image with known ground truth`,
          inference,
          { listed_modality: modality ?? null, measured },
        ),
      );
      metrics.agreement = metrics.agreement === null ? 'catalog-vs-measured' : 'catalog-and-prose-vs-measurement';
    }

    if (measured === 'pass' && listsImage) {
      metrics.agreement = metrics.agreement ?? 'catalog-and-measurement-agree';
    }

    const init: ResultInit = {
      metrics,
      findings,
      details: {
        description_excerpt: description?.slice(0, 300) ?? null,
        listed_modality: modality ?? null,
        measured: measured ?? 'not measured',
      },
    };

    if (findings.length === 0) {
      const verdict = measured
        ? `description, catalog and measurement agree that this model accepts ${listsImage ? 'images' : 'text only'}`
        : `description and catalog agree (${modality ?? 'no modality listed'}); not measured, because --vision was not run`;
      return pass(name, title, verdict, init);
    }

    // A disagreement between claims is not a provider defect: the endpoint did
    // what it did. Report it and let a reader weigh it.
    return pass(name, title, `${findings.length} claim(s) disagree; see the findings for which source is at odds with which`, init);
  },
});

function finding(
  check: string,
  id: string,
  label: string,
  observed: string,
  inference: string,
  evidence: Finding['evidence'],
): Finding {
  return { id, label, observed, inference, check, evidence };
}

function excerpt(text: string, pattern: RegExp): string {
  const match = new RegExp(pattern.source, 'i').exec(text);
  if (!match) return text.slice(0, 80);
  const start = Math.max(0, match.index - 40);
  return `…${text.slice(start, match.index + match[0].length + 40).trim()}…`;
}

/**
 * Input modalities from `architecture`.
 *
 * "text+image+video->text" has to be split on the arrow first: a naive
 * `+image+` test misses it entirely, because the last input is followed by
 * `->` rather than by a separator. That mistake reads as "text only" and
 * quietly suppresses the finding.
 */
function parseModality(modality: string | undefined, inputs: string[] | undefined): string[] {
  if (inputs && inputs.length > 0) return inputs.map((s) => s.toLowerCase());
  if (!modality) return [];
  const inputSide = modality.split('->')[0] ?? modality;
  return inputSide
    .split(/[+,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
