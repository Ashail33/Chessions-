# Square model

`src/squarenet.js` reads each square of the board as empty, white piece or
black piece with a small convolutional network (about 14 thousand weights,
run in plain JavaScript). These scripts rebuild its weights,
`src/squarenet-weights.js`, from labelled photos of real boards.

```sh
python prepare.py /tmp/squares     # download photos and piece boxes (pyarrow, pillow)
node build-data.mjs /tmp/squares   # find each board, cut out and label the 64 squares
python train.py /tmp/squares       # train, report held-out accuracy, write the weights (torch)
```

`build-data.mjs` uses the app's own `detectBoard` and `squarePatches`, so
the model is trained on exactly the cut-outs it will see in the app. A piece's
square comes from its box. Where a low-camera and an overhead estimate of
the piece's base fall on different squares, the square is left out. Photos
whose boxes mostly miss the board are skipped, and so are photos the first
round of training disagrees with on most squares. In both datasets, some
augmented copies kept the boxes of the original photo.

Last run: 98.9% of squares right on test photos the model never saw (99.3%
on one board, 98.1% on the other). Training also swaps and mixes the colour
channels, so a red, blue or brown board reads as well as the green ones in
the photos.

## Data

- [Chess Pieces](https://huggingface.co/datasets/Francesco/chess-pieces-mjzgj)
  from Roboflow 100, public domain.
- [chess-piece-detection](https://universe.roboflow.com/gustoguardian/chess-piece-detection-bltvi)
  by gustoguardian, CC BY 4.0, via
  [dopaul/chess-pieces-dominique](https://huggingface.co/datasets/dopaul/chess-pieces-dominique).
  The model's weights are derived from these photos.
