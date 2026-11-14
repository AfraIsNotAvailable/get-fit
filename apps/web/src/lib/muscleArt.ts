/** slug -> the SVG shapes that make up that muscle.
 *
 * Ported verbatim from the Python dashboard. The artwork ids are anatomical
 * (pectoralis_major_l), not our slugs, so this map is the only way a hover can
 * paint the right thing. Three groups have no artwork in this atlas —
 * serratus, lower back and hip flexors — and stay null rather than faked.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const obliques = Array.from({ length: 8 }, (_: unknown, i: number) =>
  [`external_oblique_${i + 1}_l`, `external_oblique_${i + 1}_r`]).flat();
export const MUSCLE_ART: Record<string, { view: "front" | "back"; ids: string[] } | null> = {
  chest: { view: 'front', ids: ['pectoralis_major_l', 'pectoralis_major_r'] },
  'anterior-deltoid': { view: 'front', ids: ['anterior_deltoid_l', 'anterior_deltoid_r'] },
  'lateral-deltoid': { view: 'front', ids: ['lateral_deltoid_l', 'lateral_deltoid_r'] },
  'posterior-deltoid': { view: 'back', ids: ['posterior_deltoid_l', 'posterior_deltoid_r'] },
  triceps: { view: 'back', ids: ['triceps_brachii_caput_longum_l', 'triceps_brachii_caput_longum_r',
    'triceps_brachii_caput_laterale_l', 'triceps_brachii_caput_laterale_r',
    'triceps_brachii_caput_mediale_l', 'triceps_brachii_caput_mediale_r'] },
  biceps: { view: 'front', ids: ['biceps_brachii_caput_longum_l', 'biceps_brachii_caput_longum_r',
    'biceps_brachii_caput_breve_l', 'biceps_brachii_caput_breve_r'] },
  forearms: { view: 'front', ids: ['brachioradialis_l', 'brachioradialis_r',
    'flexor_carpi_radialis_l', 'flexor_carpi_radialis_r', 'palmaris_longus_l', 'palmaris_longus_r',
    'pronator_teres_l', 'pronator_teres_r', 'flexor_digitorum_superficialis_l',
    'flexor_digitorum_superficialis_r'] },
  traps: { view: 'back', ids: ['trapezius_upper_l', 'trapezius_upper_r'] },
  lats: { view: 'back', ids: ['latissimus_dorsi_l', 'latissimus_dorsi_r'] },
  'mid-back': { view: 'back', ids: ['trapezius_middle_l', 'trapezius_middle_r',
    'trapezius_lower_l', 'trapezius_lower_r', 'infraspinatus_l', 'infraspinatus_r'] },
  abs: { view: 'front', ids: ['rectus_abdominis_1', 'rectus_abdominis_2_l', 'rectus_abdominis_2_r',
    'rectus_abdominis_3_l', 'rectus_abdominis_3_r', 'rectus_abdominis_4_l', 'rectus_abdominis_4_r'] },
  obliques: { view: 'front', ids: obliques },
  glutes: { view: 'back', ids: ['gluteus_maximus_l', 'gluteus_maximus_r'] },
  quads: { view: 'front', ids: ['rectus_femoris_l', 'rectus_femoris_r', 'vastus_lateralis_l',
    'vastus_lateralis_r', 'vastus_medialis_l', 'vastus_medialis_r', 'sartorius_l', 'sartorius_r'] },
  hamstrings: { view: 'back', ids: ['biceps_femoris_l', 'biceps_femoris_r', 'semitendinosus_l',
    'semitendinosus_r', 'semimembranosus_1_l', 'semimembranosus_1_r',
    'semimembranosus_2_l', 'semimembranosus_2_r'] },
  adductors: { view: 'front', ids: ['adductor_longus_l', 'adductor_longus_r', 'adductor_magnus_l',
    'adductor_magnus_r', 'gracilis_l', 'gracilis_r', 'pectineus_l', 'pectineus_r'] },
  abductors: { view: 'front', ids: ['gluteus_medius_2_l', 'gluteus_medius_2_r'] },
  calves: { view: 'front', ids: ['gastrocnemius_l', 'gastrocnemius_r', 'tibialis_anterior_l',
    'tibialis_anterior_r', 'fibularis_longus_l', 'fibularis_longus_r'] },
  neck: { view: 'front', ids: ['sternocleidomastoid_l', 'sternocleidomastoid_r', 'platysma'] },
  // no artwork in this atlas yet — pending a dataset that includes them
  'serratus-anterior': null, 'lower-back': null, 'hip-flexors': null,
};
