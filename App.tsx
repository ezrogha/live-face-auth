import React from "react";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View, Dimensions } from "react-native";
import { Camera, FaceDetectionResult } from "expo-camera";
import MaskedView from "@react-native-community/masked-view";
import { AnimatedCircularProgress } from "react-native-circular-progress";
import * as FaceDetector from "expo-face-detector";
import { contains, Rect } from "./utils/contains";

const { width: windowWidth } = Dimensions.get("window");

const PREVIEW_SIZE = 325;
const PREVIEW_RECT = {
  minX: (windowWidth - PREVIEW_SIZE) / 2, //leftmargin
  minY: 50, // topmargin
  width: PREVIEW_SIZE,
  height: PREVIEW_SIZE,
};

const instructionsText = {
  initialPrompt: "Position your face in the circle",
  performActions: "Keep the device still and perform the following actions:",
  tooClose: "You're too close. Hold the device further.",
};

const detections = {
  BLINK: { instruction: "Blink both eyes", minProbability: 0.3 },
  TURN_HEAD_LEFT: { instruction: "Turn head left", maxAngle: -15 },
  TURN_HEAD_RIGHT: { instruction: "Turn head right", minAngle: 15 },
  NOD: { instruction: "Nod", minDiff: 1.5 },
  SMILE: { instruction: "Smile", minProbability: 0.7 },
};

type DetectionActions = keyof typeof detections;

const detectionsList: DetectionActions[] = [
  "BLINK",
  "TURN_HEAD_LEFT",
  "TURN_HEAD_RIGHT",
  "NOD",
  "SMILE",
];

const initialState = {
  faceDetected: "no" as "yes" | "no",
  faceTooBig: "no" as "yes" | "no",
  detectionsList,
  currentDetectionIndex: 0,
  progressFill: 0,
  processComplete: false,
};

interface Actions {
  FACE_DETECTED: "yes" | "no";
  FACE_TOO_BIG: "yes" | "no";
  NEXT_DETECTION: null;
}

interface Action<T extends keyof Actions> {
  type: T;
  payload: Actions[T];
}

type PossibleActions = {
  [K in keyof Actions]: Action<K>;
}[keyof Actions];

const detectionReducer = (
  state: typeof initialState,
  action: PossibleActions
): typeof initialState => {
  switch (action.type) {
    case "FACE_DETECTED":
      if (action.payload === "yes") {
        return {
          ...state,
          faceDetected: action.payload,
          progressFill: 100 / (state.detectionsList.length + 1),
        };
      } else {
        // Reset
        return initialState;
      }
    case "FACE_TOO_BIG":
      return { ...state, faceTooBig: action.payload };
    case "NEXT_DETECTION":
      // Next detection index
      const nextDetectionIndex = state.currentDetectionIndex + 1;

      // Skip 0 index
      const progressMultiplier = nextDetectionIndex + 1;

      const newProgressFill =
        (100 / (state.detectionsList.length + 1)) * progressMultiplier;

      if (nextDetectionIndex === state.detectionsList.length) {
        // Passed
        return {
          ...state,
          processComplete: true,
          progressFill: newProgressFill,
        };
      }

      // Next detection
      return {
        ...state,
        currentDetectionIndex: nextDetectionIndex,
        progressFill: newProgressFill,
      };
    default:
      throw new Error("Unexpected action type.");
  }
};

export default function App() {
  const [hasPermission, setHasPermission] = React.useState(false);
  const [state, dispatch] = React.useReducer(detectionReducer, initialState);
  const rollAngles = React.useRef<number[]>([])

  React.useEffect(() => {
    if (state.processComplete) {
      setTimeout(() => {
        // It's very important that the user feels fulfilled by
        // witnessing the progress fill up to 100%.
      }, 500)
    }
  }, [state.processComplete])

  React.useEffect(() => {
    const requestPermissions = async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === "granted");
    };
    requestPermissions();
  }, []);

  const handleFaceDetection = (result: FaceDetectionResult) => {
    // Only one face needed
    if (result.faces.length !== 1) {
      dispatch({ type: "FACE_DETECTED", payload: "no" });
      return;
    }

    const face = result.faces[0];

    const faceRect: Rect = {
      minX: face.bounds.origin.x,
      minY: face.bounds.origin.y,
      width: face.bounds.size.width,
      height: face.bounds.size.height,
    };

    // Face is fully contained within the camera preview.
    const edgeOffset = 50;

    // makes the inner rect a bit smaller
    const faceRectSmaller: Rect = {
      ...faceRect,
      width: faceRect.width - edgeOffset,
      height: faceRect.height - edgeOffset,
      // minY: faceRect.minY + edgeOffset / 2,
      // minX: faceRect.minX + edgeOffset / 2
    };

    const previewContainsFace = contains({
      outside: PREVIEW_RECT,
      inside: faceRectSmaller,
    });

    if (!previewContainsFace) {
      dispatch({ type: "FACE_DETECTED", payload: "no" });
      return;
    }

    if (state.faceDetected === "no") {
      // Face is not as big as the camera preview.
      const faceMaxSize = PREVIEW_SIZE - 90;
      if (faceRect.width >= faceMaxSize && faceRect.height >= faceMaxSize) {
        dispatch({ type: "FACE_TOO_BIG", payload: "yes" });
        return;
      }

      if (state.faceTooBig === "yes") {
        dispatch({ type: "FACE_TOO_BIG", payload: "no" });
      }
    }

    if (state.faceDetected === "no") {
      dispatch({ type: "FACE_DETECTED", payload: "yes" });
    }

    const detectionAction = state.detectionsList[state.currentDetectionIndex];

    switch (detectionAction) {
      case "BLINK":
        // Lower probabiltiy is when eyes are closed
        const leftEyeClosed =
          face.leftEyeOpenProbability <= detections.BLINK.minProbability;
        const rightEyeClosed =
          face.rightEyeOpenProbability <= detections.BLINK.minProbability;
        if (leftEyeClosed && rightEyeClosed) {
          dispatch({ type: "NEXT_DETECTION", payload: null });
        }
        return;
      case "NOD":
        // Collect roll angle data in ref
        rollAngles.current.push(face.rollAngle);

        // Don't keep more than 10 roll angles (10 detection frames)
        if (rollAngles.current.length > 10) {
          rollAngles.current.shift();
        }

        // If not enough roll angle data, then don't process
        if (rollAngles.current.length < 10) return;

        // Calculate avg from collected data, except current angle data
        const rollAnglesExceptCurrent = [...rollAngles.current].splice(
          0,
          rollAngles.current.length - 1
        );

        // Summation
        const rollAnglesSum = rollAnglesExceptCurrent.reduce((prev, curr) => {
          return prev + Math.abs(curr);
        }, 0);

        // Average
        const avgAngle = rollAnglesSum / rollAnglesExceptCurrent.length;

        // If the difference between the current angle and the average is above threshold, pass.
        const diff = Math.abs(avgAngle - Math.abs(face.rollAngle));

        if (diff >= detections.NOD.minDiff) {
          dispatch({ type: "NEXT_DETECTION", payload: null });
        }
        return;
      case "TURN_HEAD_LEFT":
        // Negative angle is the when the face turns left
        if (face.yawAngle <= detections.TURN_HEAD_LEFT.maxAngle) {
          dispatch({ type: "NEXT_DETECTION", payload: null });
        }
        return;
      case "TURN_HEAD_RIGHT":
        // Positive angle is the when the face turns right
        if (face.yawAngle >= detections.TURN_HEAD_RIGHT.minAngle) {
          dispatch({ type: "NEXT_DETECTION", payload: null });
        }
        return;
      case "SMILE":
        // Higher probabiltiy is when smiling
        if (face.smilingProbability >= detections.SMILE.minProbability) {
          dispatch({ type: "NEXT_DETECTION", payload: null });
        }
        return;
    }
  };

  if (hasPermission === false || hasPermission === null) {
    return <Text>No access to camera</Text>;
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <MaskedView
        style={StyleSheet.absoluteFill}
        maskElement={<View style={styles.mask} />}
      >
        <Camera
          style={styles.maskedView}
          type={Camera.Constants.Type.front}
          onFacesDetected={handleFaceDetection}
          faceDetectorSettings={{
            mode: FaceDetector.FaceDetectorMode.fast,
            detectLandmarks: FaceDetector.FaceDetectorClassifications.none,
            runClassifications: FaceDetector.FaceDetectorClassifications.none,
            minDetectionInterval: 100,
            tracking: true,
          }}
        />
      </MaskedView>
      <View style={styles.instructionsContainer}>
        <Text style={styles.instructions}>
          {state.faceDetected === "no" &&
            state.faceTooBig === "no" &&
            instructionsText.initialPrompt}

          {state.faceTooBig === "yes" && instructionsText.tooClose}

          {state.faceDetected === "yes" &&
            state.faceTooBig === "no" &&
            instructionsText.performActions}
        </Text>
        <Text style={styles.action}>
          {state.faceDetected === "yes" &&
            state.faceTooBig === "no" &&
            detections[state.detectionsList[state.currentDetectionIndex]]
              .instruction}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  mask: {
    borderRadius: PREVIEW_SIZE / 2,
    height: PREVIEW_SIZE,
    width: PREVIEW_SIZE,
    marginTop: PREVIEW_RECT.minY,
    alignSelf: "center",
    backgroundColor: "white",
  },
  circularProgress: {
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
    marginTop: PREVIEW_RECT.minY,
    marginLeft: PREVIEW_RECT.minX,
  },
  maskedView: {
    ...StyleSheet.absoluteFillObject,
  },
  instructions: {
    fontSize: 20,
    textAlign: "center",
    top: 25,
    position: "absolute",
  },
  instructionsContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    marginTop: PREVIEW_RECT.minY + PREVIEW_SIZE,
  },
  action: {
    fontSize: 24,
    textAlign: "center",
    fontWeight: "bold",
  },
});
