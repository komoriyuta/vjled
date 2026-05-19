Downloaded lightweight CPU music tagger:

- msd-musicnn-1.onnx: Essentia MusiCNN tag model, input [1, 187, 96], output 50 tag probabilities.
- msd-musicnn-1.json: metadata and tag labels.

Run `npm run fetch-models` to download the ONNX file. The ONNX weights are ignored by Git.

The model is from https://essentia.upf.edu/models/ and is licensed by MTG under a non-commercial Creative Commons license; check the upstream license before redistribution or commercial use.
