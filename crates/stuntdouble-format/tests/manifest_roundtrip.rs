use stuntdouble_format::{
    BundleManifest, HotspotId, SCHEMA_VERSION, SCHEMA_VERSION_V1, SceneId, SceneKind,
};

#[test]
fn interactive_manifest_fixture_round_trips_and_validates() {
    // A v1 bundle: it loads, migrated to v2, with its scenes read as fallback scenes.
    let (manifest, read_as) =
        BundleManifest::from_json_str(include_str!("fixtures/interactive.scenecast/manifest.json"))
            .unwrap();

    assert_eq!(read_as, SCHEMA_VERSION_V1);
    assert_eq!(manifest.schema_version, SCHEMA_VERSION);
    assert!(manifest.validate().is_valid());
    assert!(
        manifest
            .graph
            .scenes
            .iter()
            .all(|scene| scene.kind == SceneKind::Screenshot)
    );
    assert_eq!(manifest.title, "Interactive fixture");

    let start = manifest
        .graph
        .scene(&SceneId::new("start").unwrap())
        .unwrap();
    assert!(
        start
            .hotspot(&HotspotId::new("pricing-link").unwrap())
            .is_some()
    );

    let serialized = serde_json::to_string_pretty(&manifest).unwrap();
    let round_tripped: BundleManifest = serde_json::from_str(&serialized).unwrap();
    assert_eq!(manifest, round_tripped);
}
