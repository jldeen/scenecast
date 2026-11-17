//! Write deduplicated stream frames and their timing index.

use std::fs;
use std::path::{Component, Path};

use serde::Serialize;
use serde_json::{Value, ser::PrettyFormatter};

#[derive(Serialize)]
struct Frame {
    file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    t: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw: Option<Value>,
}

pub struct StreamWriter {
    name: String,
    previous: String,
    frames: Vec<Frame>,
}

impl StreamWriter {
    pub fn new(root: &Path, name: String) -> Result<Self, String> {
        let mut components = Path::new(&name).components();
        if name.contains('\\')
            || !matches!(components.next(), Some(Component::Normal(_)))
            || components.next().is_some()
        {
            return Err("invalid stream name".into());
        }
        let dir = root.join(&name);
        fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
        Ok(Self {
            name,
            previous: String::new(),
            frames: Vec::new(),
        })
    }

    pub fn push(&mut self, root: &Path, frame: &Value) -> Result<(), String> {
        let html = frame
            .get("html")
            .and_then(Value::as_str)
            .ok_or("missing stream frame HTML")?;
        if html == self.previous {
            return Ok(());
        }
        let file = format!("{:03}.html", self.frames.len());
        let path = root.join(&self.name).join(&file);
        fs::write(&path, html).map_err(|error| format!("{}: {error}", path.display()))?;
        self.previous = html.to_owned();
        self.frames.push(Frame {
            file,
            t: frame.get("t").cloned(),
            raw: frame.get("raw").cloned(),
        });
        Ok(())
    }

    pub fn finish(self, root: &Path) -> Result<usize, String> {
        #[derive(Serialize)]
        struct Index<'a> {
            name: &'a str,
            frames: &'a [Frame],
        }
        let path = root.join(format!("{}.json", self.name));
        let index = Index {
            name: &self.name,
            frames: &self.frames,
        };
        let mut data = Vec::new();
        let mut serializer =
            serde_json::Serializer::with_formatter(&mut data, PrettyFormatter::with_indent(b" "));
        index
            .serialize(&mut serializer)
            .map_err(|e| e.to_string())?;
        fs::write(&path, data).map_err(|error| format!("{}: {error}", path.display()))?;
        Ok(self.frames.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deduplicates_adjacent_frames_and_keeps_timing() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = StreamWriter::new(dir.path(), "sample".into()).unwrap();
        writer
            .push(dir.path(), &json!({"html":"a","t":0,"raw":1}))
            .unwrap();
        writer
            .push(dir.path(), &json!({"html":"a","t":10,"raw":2}))
            .unwrap();
        writer
            .push(dir.path(), &json!({"html":"b","t":20,"raw":3}))
            .unwrap();
        assert_eq!(writer.finish(dir.path()).unwrap(), 2);
        assert_eq!(
            fs::read_to_string(dir.path().join("sample/001.html")).unwrap(),
            "b"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("sample.json")).unwrap(),
            "{\n \"name\": \"sample\",\n \"frames\": [\n  {\n   \"file\": \"000.html\",\n   \"t\": 0,\n   \"raw\": 1\n  },\n  {\n   \"file\": \"001.html\",\n   \"t\": 20,\n   \"raw\": 3\n  }\n ]\n}"
        );
        assert!(StreamWriter::new(dir.path(), "../outside".into()).is_err());
    }
}
